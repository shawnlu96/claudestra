/**
 * peer 整体加密的进程内集成测试（T21a 验收口径：进程内集成 + owner 真机检查单；docs/relay/e2e-design.md §6.1 P1b）。
 * B 全用真件：真中继（src/relay）、真 relay 客户端、真 relay-inbound → 真 peer 入口（ingressRequest）→ 真 E2E 路由
 * （bridge/peer-e2e-route.ts）→ 真兑换路由（bridge/peer-redeem.ts）+ 真 manager 邀请 / 兑换命令 → 真 authenticateApi。
 * B 的状态就是测试进程的 STATE_DIR（tests/preload.ts 给的临时目录）；A 的钥匙与 peer 表全部注入（lib/peer-e2e-outbound.ts）。
 * A 的传输里夹一个可作恶的「中继」钩子：篡改、截断、重放、伪造错误、降级成明文，relay:// 与直连 http 各走一遍。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { authenticateApi } from "../src/bridge/api-auth.ts";
import { createE2eRoute } from "../src/bridge/peer-e2e-route.ts";
import { ingressRequest } from "../src/bridge/peer-ingress.ts";
import { handlePeerRedeem } from "../src/bridge/peer-redeem.ts";
import { makeInboundHandler } from "../src/bridge/relay-inbound.ts";
import { setRequestContext } from "../src/bridge/request-context.ts";
import { keyFingerprint, signedHeaders } from "../src/lib/instance-key.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { localE2e, pinPeerE2eKey, readHttpPeers, RELAY_PAGE_INVITE_WARNING, type LocalE2e } from "../src/lib/peer-e2e-local.ts";
import { createE2eOutbound } from "../src/lib/peer-e2e-outbound.ts";
import { openRedeemRequest, readRedeemResponse, sealRedeemRequest, sealRedeemResponse, type SealedRedeem } from "../src/lib/peer-e2e-redeem.ts";
import { loadRelayPeerView, relayPeerRefusal } from "../src/lib/peer-trust.ts";
import { signInviteProof } from "../src/lib/invite-proof.ts";
import { encodePeerInviteV2, parsePeerInviteV2, readPeers, type HttpPeer, type PeerInviteV2 } from "../src/lib/peers.ts";
import { readPrincipals } from "../src/lib/principals.ts";
import { connect, type RelayClient } from "../src/lib/relay-client.ts";
import { NULL_BODY_STATUS, recordToHeaders } from "../src/lib/relay-stream.ts";
import { fromB64url, utf8 } from "../src/lib/e2e/encoding.ts";
import { runPeerInviteCommand } from "../src/manager/peers-invite-cli.ts";
import { createRelay, type Relay } from "../src/relay/server.ts";

const quiet = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STATE_FILES = ["registry.json", "peers.json", "principals.json", "peer-keys.json"];
const saved = new Map<string, string | null>();

let relay: Relay;
let ingress: Server<undefined>;
let a: RelayClient, b: RelayClient;
let localA: LocalE2e, localB: LocalE2e;
let dirA: string;
const handled: { peer: string | undefined; path: string; body: string }[] = [];

// ── B：真 peer 入口背后的迷你 API（顺序同 api-routes.handleApiRequest：E2E → 兑换 → 鉴权 → 路由）──
const route = createE2eRoute({ local: () => localE2e(), peers: readHttpPeers, pin: pinPeerE2eKey });
async function managerInProcess(...args: string[]): Promise<any> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => void out.push(String(s));
  try {
    await runPeerInviteCommand(args[0], args.slice(1));
  } finally {
    console.log = orig;
  }
  return JSON.parse(out.at(-1) ?? "null");
}
async function bApi(req: Request, url: URL): Promise<Response> {
  const e2e = await route.route(req, url, (inner) => bApi(inner, new URL(inner.url)));
  if (e2e) return e2e;
  if (url.pathname === "/api/v1/peers/redeem" && req.method === "POST") return handlePeerRedeem(req, { runManager: managerInProcess });
  const auth = await authenticateApi(req, url, { rateLimit: false });
  if (auth instanceof Response) return auth;
  const body = req.method === "GET" ? "" : await req.text();
  handled.push({ peer: auth.peer, path: url.pathname, body });
  return Response.json({ ok: true, peer: auth.peer, echo: body, n: handled.length }, { status: 201 });
}

// ── A：传输层 + 可作恶的「中继」钩子 ──
interface Wire { url: string; method: string; headers: Record<string, string>; body: Uint8Array }
type Hook = (w: Wire, send: (w: Wire) => Promise<Response>) => Promise<Response>;
let hook: Hook | null = null;
const seen: string[] = [];

async function send(w: Wire): Promise<Response> {
  seen.push(Buffer.from(w.body).toString("latin1"));
  if (!w.url.startsWith("relay://")) return fetch(w.url, { method: w.method, headers: w.headers, ...(w.body.length ? { body: w.body } : {}) });
  const u = new URL(w.url);
  const r = await a.request(u.hostname, { method: w.method, path: u.pathname + u.search, headers: w.headers, body: w.body.length ? w.body : null }, { timeoutMs: 5000 });
  const res = new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers: recordToHeaders(r.headers) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  seen.push(Buffer.from(bytes).toString("latin1"));
  return new Response(NULL_BODY_STATUS.has(r.status) ? null : bytes, { status: r.status, headers: res.headers });
}
const rawA = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) => {
  const body = typeof init.body === "string" ? utf8(init.body) : (init.body ?? new Uint8Array(0));
  const w: Wire = { url, method: (init.method ?? "GET").toUpperCase(), headers: init.headers ?? {}, body };
  return hook ? hook(w, send) : send(w);
};

let aPeers: HttpPeer[] = [];
const outA = () => createE2eOutbound({ local: async () => localA, peers: async () => aPeers, pin: async () => {}, sign: (m, p, body) => signedHeaders(m, p, body, localA.key) });
let out = outA();
let tokenForA = "";

/**
 * A 调 B：内层照生产的样子带 Bearer 与内层签名（http-peer.ts runCall 的写法）。签名时间戳精确到秒，同一秒里方法、路径、正文
 * 都相同的两次调用签名一样、会被当成重放；生产在正文里加随机 nonce，这里加在查询串上（B 的路由不看它）
 */
async function call(base: string, method: string, path: string, body?: string): Promise<Response> {
  const url = `${base}${path}?nonce=${crypto.randomUUID()}`;
  const u = new URL(url);
  const headers = { authorization: `Bearer ${tokenForA}`, "content-type": "application/json", ...signedHeaders(method, u.pathname + u.search, body ?? "", localA.key) };
  const r = await out.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) }, rawA);
  if (!r) throw new Error("not an e2e peer");
  return r;
}
/** 明文照发（模拟降级 / 老版本）：外层签名 + Bearer，不经 E2E */
function plain(base: string, method: string, path: string, body = ""): Promise<Response> {
  const url = `${base}${path}`;
  const u = new URL(url);
  const headers = { authorization: `Bearer ${tokenForA}`, "content-type": "application/json", ...signedHeaders(method, u.pathname + u.search, body, localA.key) };
  return rawA(url, { method, headers, ...(method === "GET" ? {} : { body }) });
}

let relayBase = "", httpBase = "";

beforeAll(async () => {
  for (const f of STATE_FILES) saved.set(f, existsSync(join(STATE_DIR, f)) ? readFileSync(join(STATE_DIR, f), "utf8") : null);
  writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: { "agent-x": { name: "agent-x", external: true } } }));
  for (const f of ["peers.json", "principals.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
  relay = createRelay({ base: "relay.test", port: 0, db: ":memory:", trustProxy: true, log: quiet, limits: { authPerIpPerMinute: 1000, idleTimeoutMs: 60_000 } });
  ingress = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => ingressRequest(req, bApi) });
  dirA = mkdtempSync(join(tmpdir(), "peer-e2e-a-"));
  localA = (await localE2e(dirA))!;
  localB = (await localE2e())!;
  const relayUrl = `ws://127.0.0.1:${relay.port}/v1/ws`;
  const refusePeer: Parameters<typeof makeInboundHandler>[0]["refusePeer"] = async (from, req) => relayPeerRefusal(from, req as never, await loadRelayPeerView()); // 同 relay-link.ts
  const onInbound = makeInboundHandler({ webBase: "http://127.0.0.1:9", ingressBase: () => `http://127.0.0.1:${ingress.port}`, refusePeer });
  b = connect({ relayUrl, key: localB.key, name: "Bob", slug: "bob", log: quiet, onInbound });
  a = connect({ relayUrl, key: localA.key, name: "Alice", slug: "alice", log: quiet });
  for (let t = 0; !(a.info().connected && b.info().connected); t++) {
    if (t > 200) throw new Error("relay clients did not connect");
    await sleep(25);
  }
  relayBase = `relay://${localB.fp}`;
  httpBase = `http://127.0.0.1:${ingress.port}`;
});

afterAll(() => {
  a?.close();
  b?.close();
  relay?.stop();
  ingress?.stop(true);
  for (const [f, v] of saved) v === null ? rmSync(join(STATE_DIR, f), { force: true }) : writeFileSync(join(STATE_DIR, f), v);
  rmSync(dirA, { recursive: true, force: true });
});

/** B 用真 CLI 生成邀请（--url 给定，不碰网络）；allowLegacy 走 --allow-legacy */
async function newInvite(url: string, allowLegacy = false): Promise<{ inv: PeerInviteV2; out: any }> {
  const o = await managerInProcess("peer-invite-new", "--agents", "x", "--url", url, ...(allowLegacy ? ["--allow-legacy"] : []));
  expect(o.ok).toBe(true);
  return { inv: parsePeerInviteV2(o.invite)!, out: o };
}

/** A 兑换：加密（带密钥的邀请）或明文（老版本 / --allow-legacy），经 A 的传输打到邀请里的地址 */
async function redeem(inv: PeerInviteV2, sealed: boolean) {
  const payload = { join: inv.join, name: "alice", iid: "a1b2c3d4e5f6a1b2c3d4e5f6", idk: localA.key.publicKey, key: localA.signed };
  const s = sealed ? await sealRedeemRequest(fromB64url(inv.ek!.pub)!, inv.fp!, payload) : null;
  const body = JSON.stringify(s ? s.body : { join: inv.join, name: "alice" });
  const u = new URL(`${inv.url}/api/v1/peers/redeem`);
  const res = await rawA(u.href, { method: "POST", headers: { "content-type": "application/json", ...signedHeaders("POST", u.pathname, body, localA.key) }, body });
  const json: any = await res.json().catch(() => null); // 回的不是 JSON（假服务的错页）：按失败看状态码
  return { status: res.status, json, outcome: s ? await readRedeemResponse(s.session, res.status, json) : null };
}

const leaks = (words: string[]) => words.filter((w) => seen.some((s) => s.includes(w)));
const bRecord = async (name: string) => (await readPeers()).httpPeers?.find((p) => p.name === name);

describe("兑换", () => {
  test("CLI 生成的邀请带身份公钥与签名块；加密兑换经中继成功，B 记下 required peer；中继看不到口令与 token", async () => {
    const { inv, out: o } = await newInvite(relayBase);
    expect(o.e2e).toBe(true);
    expect(inv.idk).toBe(localB.key.publicKey);
    expect(inv.ek).toEqual(localB.signed);
    seen.length = 0;
    const r = await redeem(inv, true);
    expect(r.outcome).toMatchObject({ ok: true, value: { ok: true, peer: "alice" } });
    expect(leaks([inv.join, "alice", inv.token])).toEqual([]);
    const rec = (await bRecord("alice"))!;
    expect(rec.fp).toBe(localA.fp);
    expect(rec.e2e).toEqual({ idk: localA.key.publicKey, ek: localA.signed });
    tokenForA = inv.token;
    aPeers = [
      { name: "bob", baseUrl: relayBase, outToken: inv.token, fp: localB.fp, e2e: { idk: inv.idk!, ek: inv.ek! }, addedAt: "" },
      { name: "bob-direct", baseUrl: httpBase, outToken: inv.token, fp: localB.fp, e2e: { idk: inv.idk!, ek: inv.ek! }, addedAt: "" },
    ];
    b.setContacts([localA.fp]); // 生产里 onRedeemed 触发联系人同步
    await sleep(100);
  });

  test("老版本明文兑换带密钥的邀请：403 e2e_required，提示升级或 --allow-legacy，邀请当场作废", async () => {
    const { inv } = await newInvite(relayBase);
    const r = await redeem(inv, false);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: "e2e_required" });
    expect(String(r.json.error)).toContain("--allow-legacy");
    expect((await readPeers()).pendingInvites?.some((p) => p.joinSecret === inv.join)).toBe(false);
    const tok = (await readPrincipals()).principals.find((p) => p.secret === inv.token);
    expect(tok?.disabled).toBe(true);
    expect((await redeem(inv, true)).outcome).toMatchObject({ ok: false }); // 口令已作废，加密兑换也不行了
  });

  test("经中继的网页生成（--via-relay-page）：不加密，警告写清「中继看得到」和想加密该去哪生成", async () => {
    const o = await managerInProcess("peer-invite-new", "--agents", "x", "--url", httpBase, "--via-relay-page");
    expect(o).toMatchObject({ ok: true, e2e: false });
    expect(o.warnings).toContain(RELAY_PAGE_INVITE_WARNING);
    expect(parsePeerInviteV2(o.invite)?.ek).toBeUndefined();
  });

  test("--allow-legacy：CLI 打警告，明文兑换放行，建出的是 legacy peer（明文请求照旧可用）", async () => {
    const { inv, out: o } = await newInvite(httpBase, true);
    expect(o.e2e).toBe(false);
    expect(o.warnings.join("\n")).toContain("不加密");
    expect(inv.idk).toBeUndefined();
    const r = await redeem(inv, false);
    expect(r.json).toMatchObject({ ok: true });
    expect((await bRecord(r.json.peer))?.e2e).toBeUndefined();
  });
});

describe("解开的内层照旧过 peerGate", () => {
  test("会话发起方拿着别的 peer 的 token：403 e2e_peer_mismatch，签名都不用看", async () => {
    const req = new Request("http://b.local/api/v1/agents", { headers: { authorization: `Bearer ${tokenForA}` } });
    setRequestContext(req, { source: "peer-ingress", clientIp: null, https: false, e2e: { peerFp: "aaaa-bbbb-cccc-dddd" } });
    const res = await authenticateApi(req, new URL(req.url), { rateLimit: false });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    expect(await (res as Response).json()).toMatchObject({ code: "e2e_peer_mismatch" });
  });
});

for (const [label, base] of [["relay://", () => relayBase], ["直连 http", () => httpBase]] as const) {
  describe(`${label}：往返、降级、作恶的中继`, () => {
    test("加密往返：B 按 alice 的 token 与签名认出人；中继看不到路径、token、正文", async () => {
      seen.length = 0;
      const n = handled.length;
      const res = await call(base(), "POST", "/api/v1/agents/x/messages", "机密内容");
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ ok: true, peer: "alice", echo: "机密内容" });
      expect(handled.length).toBe(n + 1);
      expect(leaks(["/api/v1/agents/x/messages", tokenForA, "机密", "alice"])).toEqual([]);
    });

    test("降级成明文（中继剥掉加密 / 发送方被骗走明文）：403 e2e_required，路由没处理", async () => {
      const n = handled.length;
      const res = await plain(base(), "POST", "/api/v1/agents/x/messages", "{}");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "e2e_required" });
      expect(handled.length).toBe(n);
    });

    // 外层签名盖住正文：中继路径上改帧先被 relay-inbound 拒（signature mismatch），直连的先被 peer-e2e-route 拒（401 e2e_signature）
    test("篡改请求、截掉最后一条（final）：都被拒，没被处理，也没退回明文", async () => {
      const n = handled.length;
      for (const cut of [(b: Uint8Array) => b.map((x, i) => (i === b.length - 1 ? x ^ 1 : x)), (b: Uint8Array) => b.subarray(0, b.length - 20)]) {
        const sent: string[] = [];
        hook = async (w, s) => (sent.push(w.url), w.url.endsWith("/hello") ? s(w) : s({ ...w, body: cut(w.body) }));
        const err = await call(base(), "POST", "/api/v1/agents/x/messages", "x").catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        if (label === "直连 http") expect(err).toMatchObject({ code: "e2e_signature" });
        expect(sent.every((u) => u.includes("/api/v1/e2e/"))).toBe(true);
      }
      hook = null;
      expect(handled.length).toBe(n);
    });

    test("重放录下的记录 → 409 e2e_replay，只处理一次", async () => {
      let captured: Wire | null = null;
      hook = async (w, s) => {
        if (!w.url.endsWith("/hello")) captured = w;
        return s(w);
      };
      const n = handled.length;
      await call(base(), "POST", "/api/v1/agents/x/messages", "once");
      hook = null;
      // 中继路径上外层签名先撞 relay-inbound 的重放缓存；直连撞 E2E 的防重放窗口
      const again = await send(captured!).catch((e) => e);
      if (label === "relay://") expect(again).toMatchObject({ code: "replay" });
      else {
        expect(again.status).toBe(409);
        expect(await again.json()).toMatchObject({ code: "e2e_replay" });
      }
      expect(handled.length).toBe(n + 1);
    });

    test("改响应 → A 抛 e2e_record；伪造 401 e2e_session（原请求已处理）→ A 拿到「不要重发」，只处理一次", async () => {
      hook = async (w, s) => {
        const r = await s(w);
        if (w.url.endsWith("/hello")) return r;
        const bytes = new Uint8Array(await r.arrayBuffer());
        bytes[8] ^= 1;
        return new Response(bytes, { status: r.status, headers: r.headers });
      };
      await expect(call(base(), "GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_record" });
      let forged = false;
      hook = async (w, s) => {
        const r = await s(w);
        if (forged || w.url.endsWith("/hello")) return r;
        forged = true;
        return Response.json({ ok: false, code: "e2e_session" }, { status: 401 });
      };
      const n = handled.length;
      const res = await call(base(), "POST", "/api/v1/agents/x/messages", "pay once");
      hook = null;
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("不要重发");
      expect(handled.length).toBe(n + 1);
    });

    test("中继回 502 / 假 200：抛错，绝不换明文重试", async () => {
      for (const fake of [() => new Response("bad gateway", { status: 502 }), () => Response.json({ ok: true })]) {
        const sent: string[] = [];
        hook = async (w, s) => {
          sent.push(w.url);
          return w.url.endsWith("/hello") ? s(w) : fake();
        };
        await expect(call(base(), "POST", "/api/v1/agents/x/messages", "p")).rejects.toThrow();
        expect(sent.every((u) => u.includes("/api/v1/e2e/"))).toBe(true);
      }
      hook = null;
    });
  });
}

describe("会话与 peer 生命期", () => {
  test("B 上删掉 alice：会话作废，重新握手被拒，路由不处理", async () => {
    await call(relayBase, "GET", "/api/v1/agents");
    const data = await readPeers();
    const rec = data.httpPeers!.find((p) => p.name === "alice")!;
    rec.disabled = true;
    writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify(data));
    const n = handled.length;
    await expect(call(relayBase, "POST", "/api/v1/agents/x/messages", "late")).rejects.toThrow();
    expect(handled.length).toBe(n);
    rec.disabled = false;
    writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify(data));
    out = outA(); // 换一个 client：丢掉失败留下的状态
    expect((await call(relayBase, "GET", "/api/v1/agents")).status).toBe(201);
  });

  test("fingerprint 自检：A 的指纹就是它身份公钥算出来的", () => {
    expect(localA.fp).toBe(keyFingerprint(localA.key.publicKey));
  });
});

describe("兑换方（B 加入 carol 的邀请）：失败响应中继能伪造，本地状态一概不动", () => {
  type Mode = "fail" | "plain-ok" | "tampered" | "no-proof" | "sealed-ok";
  let mode: Mode = "fail";
  let carol: LocalE2e;
  let srv: Server<undefined>;
  const dirC = mkdtempSync(join(tmpdir(), "peer-e2e-c-"));
  const CAROL_IID = "c0c0c0c0c0c0c0c0c0c0c0c0";

  beforeAll(async () => {
    carol = (await localE2e(dirC))!;
    srv = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as SealedRedeem;
        if (mode === "fail") return Response.json({ ok: false, error: "邀请无效或已被使用" }, { status: 400 });
        if (mode === "plain-ok") return Response.json({ ok: true, peer: "b", agents: ["x"], token: "relay-token" });
        const opened = (await openRedeemRequest(carol.machine.pair, carol.fp, body))!;
        const p = opened.payload as { nonce: string; join: string; inviteUrl: string; idk: string };
        const fields = { nonce: p.nonce, join: p.join, redeemerFp: keyFingerprint(p.idk), inviterIid: CAROL_IID, inviteUrl: p.inviteUrl };
        const proof = mode === "no-proof" ? {} : { proof: signInviteProof(fields, carol.key), iid: CAROL_IID }; // T25 的持钥证明，放在加密响应里
        const sealed = await sealRedeemResponse(opened.session, { ok: true, peer: "b", agents: ["x"], ...proof });
        if (mode === "tampered") sealed.ct = Buffer.from(Buffer.from(sealed.ct, "base64url").map((x, i) => (i === 0 ? x ^ 1 : x))).toString("base64url");
        return Response.json(sealed);
      },
    });
  });
  afterAll(() => {
    srv?.stop(true);
    rmSync(dirC, { recursive: true, force: true });
  });

  const invite = (over: Partial<PeerInviteV2> = {}) => encodePeerInviteV2({
    v: 2, name: "carol", url: `http://127.0.0.1:${srv.port}`, token: "t".repeat(40), join: "j".repeat(40), iid: CAROL_IID,
    fp: carol.fp, idk: carol.key.publicKey, ek: carol.signed, ...over,
  });

  test("伪造的明文失败、伪造的明文「成功」、改过的密文、解得开却没有持钥证明：都只报错，peers.json 与 principals 一个字节都不变", async () => {
    for (const m of ["fail", "plain-ok", "tampered", "no-proof"] as Mode[]) {
      mode = m;
      const before = [readFileSync(join(STATE_DIR, "peers.json"), "utf8"), JSON.stringify(await readPrincipals())];
      const o = await managerInProcess("peer-join-auto", invite());
      expect(o.ok).toBe(false);
      expect(o.error).toContain("本地未做改动");
      expect([readFileSync(join(STATE_DIR, "peers.json"), "utf8"), JSON.stringify(await readPrincipals())]).toEqual(before);
    }
  });

  test("邀请里的签名块不是邀请方身份签的：连网络都不碰就拒", async () => {
    mode = "sealed-ok";
    const o = await managerInProcess("peer-join-auto", invite({ ek: { ...carol.signed, ts: carol.signed.ts + 1 } }));
    expect(o).toMatchObject({ ok: false });
    expect(o.error).toContain("验签没过");
  });

  test("解得开的加密成功：这时才落盘，记成 required peer", async () => {
    mode = "sealed-ok";
    const o = await managerInProcess("peer-join-auto", invite());
    expect(o).toMatchObject({ ok: true, peer: "carol", remoteAgents: ["x"] });
    const rec = (await bRecord("carol"))!;
    expect(rec.fp).toBe(carol.fp);
    expect(rec.publicKey).toBe(carol.key.publicKey);
    expect(rec.instanceId).toBe(CAROL_IID);
    expect(rec.e2e).toEqual({ idk: carol.key.publicKey, ek: carol.signed });
  });
});
