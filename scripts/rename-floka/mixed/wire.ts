/**
 * 隔离矩阵的网络一侧：真中心（src/relay/server.ts，:memory: 库，127.0.0.1 随机端口）× 三个真客户端（src/lib/relay-client.ts）。
 * 每次互发都走中心转发，正文带台账签名（LEDGER1），头带请求签名（SIGN1）；发送族只按对端已认证的能力证明选，
 * 接收方按自己当时的档位验。中心「升级」= 停掉旧中心、同一端口起双认的新中心，客户端照常退避重连。
 */
import { createRelay, type Relay } from "../../../src/relay/server.ts";
import { connect, type RelayClient } from "../../../src/lib/relay-client.ts";
import { keyFingerprint } from "../../../src/lib/relay-protocol.ts";
import { issueSignatureCapability, chooseSendFamily, type SignatureCapability } from "../../../src/lib/floka-compat/signature/capability.ts";
import { signRequestFamily, verifyRequestFamilies } from "../../../src/lib/floka-compat/signature/request.ts";
import type { SignatureFamily } from "../../../src/lib/floka-compat/signature/families.ts";
import { ledgerSendFamily, receiveLedgerUse, signLedgerUse, type LedgerSigned } from "../../../src/lib/floka-ledger/uses.ts";
import type { MixedInstance } from "./instance.ts";

const BASE = "relay.mixed.invalid";
/** 假中心只在本机回环上起（端口每次随机） */
export const CENTER = "ws://127.0.0.1/v1/ws";
const PATH = "/api/v1/mixed";
const quiet = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gear = (v: unknown): "off" | "observe" | "on" => (v === "on" || v === "observe" ? v : "off");

/** 接收方记下的一次到达：两类签名各是哪一族，以及转发头里有没有新族字样 */
export interface Arrival {
  from: string;
  to: string;
  request: SignatureFamily | "rejected";
  ledger: SignatureFamily | "rejected";
  flokaHeaders: string[];
}

export interface Wire {
  relay: Relay;
  port: number;
  centerNew: boolean;
  clients: Map<string, RelayClient>;
  arrivals: Arrival[];
  insts: MixedInstance[];
}

const fpOf = (i: MixedInstance): string => keyFingerprint(i.key.publicKey);

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting: ${what}`);
    await sleep(15);
  }
}

/** 实例对外宣告的能力证明：只有开了接收（新版本且双认）才有 */
function advertised(i: MixedInstance): SignatureCapability | undefined {
  return i.rename.signature === "on" ? issueSignatureCapability(i.instanceId, i.key) ?? undefined : undefined;
}

function startCenter(port: number, dual: boolean): Relay {
  return createRelay({ base: BASE, port, db: ":memory:", log: quiet, limits: { authPerIpPerMinute: 10_000 }, ...(dual ? { rename: { centerReceive: "on", centerSend: "on" } } : {}) });
}

/** 收到的请求：按接收方当时的档位验请求签名与台账签名，结论记进 arrivals */
function inbound(w: Wire, me: MixedInstance) {
  return async (req: { method: string; path: string; headers: Record<string, string>; body: ReadableStream<Uint8Array> }, ctx: { from: string }) => {
    const body = await new Response(req.body).text();
    const sender = w.insts.find((i) => fpOf(i) === ctx.from);
    const msg = JSON.parse(body) as { fields: string[]; ledger: LedgerSigned };
    const r = verifyRequestFamilies(req.headers, { method: req.method, path: req.path, body }, gear(me.rename.signature));
    const l = receiveLedgerUse("shared-ledger", msg.ledger, msg.fields, { receive: gear(me.rename.ledgerReceive) }, sender?.key.publicKey);
    w.arrivals.push({
      from: sender?.name ?? ctx.from, to: me.name,
      request: r.status === "ok" ? r.family : "rejected", ledger: l.ok ? l.family : "rejected",
      flokaHeaders: Object.keys(req.headers).filter((k) => k.toLowerCase().includes("floka")),
    });
    return { status: r.status === "ok" && l.ok ? 200 : 401, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("ok") };
  };
}

/** 按实例当前的中心档位连一次（客户端重启 = 新连接，之前学到的中心能力不带过去） */
function dial(w: Wire, i: MixedInstance): RelayClient {
  w.clients.get(i.name)?.close();
  const rename = { centerReceive: i.rename.centerReceive, centerSend: i.rename.centerSend };
  const c = connect({
    relayUrl: CENTER.replace("127.0.0.1", `127.0.0.1:${w.port}`), key: i.key, name: i.name, slug: i.name, log: quiet,
    ...(rename.centerReceive ? { rename } : {}),
    timing: { backoffMs: [30], fatalRetryMs: 30, heartbeatMs: 60_000 }, onInbound: inbound(w, i),
  });
  w.clients.set(i.name, c);
  return c;
}

async function settle(w: Wire): Promise<void> {
  await waitFor(() => [...w.clients.values()].every((c) => c.state === "online"), "clients online");
  for (const i of w.insts) w.clients.get(i.name)!.setContacts(w.insts.filter((o) => o !== i).map(fpOf));
  await sleep(60);
}

export async function startWire(insts: MixedInstance[]): Promise<Wire> {
  const relay = startCenter(0, false);
  const w: Wire = { relay, port: relay.port, centerNew: false, clients: new Map(), arrivals: [], insts };
  for (const i of insts) dial(w, i);
  await settle(w);
  return w;
}

/** 中心换版本：同一端口重起，客户端自行重连 */
export async function setCenter(w: Wire, dual: boolean): Promise<void> {
  w.relay.stop();
  await waitFor(() => [...w.clients.values()].every((c) => c.state !== "online"), "clients notice center restart");
  w.relay = startCenter(w.port, dual);
  w.centerNew = dual;
  await settle(w);
}

/** 实例进程重启（services 切换后）：按新档位重新连接 */
export async function restartClient(w: Wire, i: MixedInstance): Promise<void> {
  dial(w, i);
  await settle(w);
}

/** 让中心顶掉一次连接：客户端带着上次 welcome 学到的能力重连 */
export async function reconnect(w: Wire, i: MixedInstance): Promise<void> {
  w.relay.dropConnection(fpOf(i));
  await waitFor(() => w.clients.get(i.name)!.state !== "online", "drop noticed");
  await settle(w);
}

export const familyOf = (w: Wire, i: MixedInstance): string => w.clients.get(i.name)!.family;

/** 发送方选族：自己的发送档 + 对端已认证（对得上钉住的实例 id 与公钥）的能力证明 */
function sendFamilies(from: MixedInstance, to: MixedInstance): { request: SignatureFamily; ledger: SignatureFamily } {
  const pinned = { instanceId: to.instanceId, publicKey: to.key.publicKey };
  const capability = advertised(to);
  return {
    request: chooseSendFamily({ allowNew: from.rename.peerRequestSend === "on", capability, pinned }),
    ledger: ledgerSendFamily(gear(from.rename.ledgerSend), { capability, pinned }).family,
  };
}

/** 一轮互发：六个有向对各一条；返回本轮的到达与失败 */
export async function exchange(w: Wire, force?: SignatureFamily): Promise<{ arrivals: Arrival[]; failures: string[] }> {
  const start = w.arrivals.length, failures: string[] = [];
  for (const from of w.insts) {
    for (const to of w.insts) {
      if (from === to) continue;
      const fam = force ? { request: force, ledger: force } : sendFamilies(from, to);
      const fields = ["mixed", from.instanceId, to.instanceId, String(w.arrivals.length)];
      const body = JSON.stringify({ fields, ledger: signLedgerUse("shared-ledger", fields, from.key, fam.ledger) });
      const headers = { "content-type": "application/json", ...signRequestFamily(fam.request, { method: "POST", path: PATH, body }, from.key) };
      try {
        const res = await w.clients.get(from.name)!.request(fpOf(to), { method: "POST", path: PATH, headers, body: new TextEncoder().encode(body) });
        await new Response(res.body).arrayBuffer();
        if (res.status !== 200) failures.push(`${from.name}→${to.name}: ${res.status}`);
      } catch (e) {
        failures.push(`${from.name}→${to.name}: ${(e as Error).message}`);
      }
    }
  }
  return { arrivals: w.arrivals.slice(start), failures };
}

export function stopWire(w: Wire): void {
  for (const c of w.clients.values()) c.close();
  w.relay.stop();
}
