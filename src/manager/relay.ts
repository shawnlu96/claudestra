/**
 * manager 侧的中继相关（bridge/relay-routes.ts 的回环路由是它的后端）：
 *   - `claudestra pair`：向 bridge 要一个配对短码，终端打印二维码 / 链接 / 短码；
 *   - `claudestra relay-status`：中继连接状态；
 *   - peerCliFetch：peer 命令里对 relay:// 地址的 fetch 替身——只有 bridge 持有中继连接，manager 请它代调。
 */
import { toString as qrToString } from "qrcode";
import { bridgeHttpBase } from "../lib/bridge-port.js";
import { instanceKeySync, keyFingerprint } from "../lib/instance-key.js";
import { relayPeerFingerprint } from "../lib/peers.js";
import type { RelayLinkInfo } from "../lib/relay-client-types.js";
import type { PeerRecord } from "../lib/relay-protocol.js";
import { NULL_BODY_STATUS, b64 } from "../lib/relay-stream.js";
import { output } from "./core.js";

/** GET /relay/status 的响应（bridge/relay-routes.ts） */
export type RelayStatus = RelayLinkInfo & { ok: boolean; peers: PeerRecord[]; pairingCodes: number };

/** bridge 没起来返回 null（不是错：没连中继就没有中继地址可用） */
export async function relayStatus(): Promise<RelayStatus | null> {
  try {
    const r = await fetch(`${bridgeHttpBase()}/relay/status`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as RelayStatus) : null;
  } catch {
    return null; // bridge 不在跑：调用方按「没有中继」处理，走直连地址
  }
}

/** 本机实例指纹（邀请载荷带上，被邀方据此在中继上放行我们） */
export function myFingerprint(): string | undefined {
  const k = instanceKeySync();
  return k ? keyFingerprint(k.publicKey) : undefined;
}

const TIMEOUT_CODES = new Set(["timeout", "local_timeout", "peer_disconnected", "connection_lost"]);

/** fetch 的替身：relay://<指纹>/… 交给 bridge 经中继代调（POST /relay/request），其余原样 fetch */
export async function peerCliFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const m = /^relay:\/\/([^/]+)(\/.*)?$/i.exec(url);
  const to = m ? relayPeerFingerprint(`relay://${m[1]}`) : null;
  if (!m || !to) return fetch(url, init);
  const r = await fetch(`${bridgeHttpBase()}/relay/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, method: init.method ?? "GET", path: m[2] || "/", headers: init.headers ?? {}, ...(init.body ? { body: b64.enc(new TextEncoder().encode(init.body)) } : {}) }),
    signal: init.signal ?? AbortSignal.timeout(45_000),
  });
  type Relayed = { ok?: boolean; status?: number; headers?: Record<string, string>; body?: string; code?: string; error?: string };
  const j = (await r.json().catch(() => null)) as Relayed | null; // bridge 回的不是 JSON（起了别的东西在这个端口）：下面按失败处理，状态码照样带出
  if (!r.ok || !j?.ok) {
    const err = new Error(`relay ${j?.code ?? r.status}: ${j?.error ?? "bridge 拒绝代调"}`);
    if (j?.code && TIMEOUT_CODES.has(j.code)) err.name = "TimeoutError";
    throw err;
  }
  const status = j.status ?? 502;
  return new Response(NULL_BODY_STATUS.has(status) ? null : b64.dec(j.body ?? ""), { status, headers: j.headers ?? {} });
}

interface PairInfo { ok: boolean; code: string; display: string; url: string; base: string; slug: string; expiresAt: string; error?: string }

export async function cmdPair(asJson: boolean): Promise<void> {
  let r: Response;
  try {
    r = await fetch(`${bridgeHttpBase()}/relay/pair/new`, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch (e) {
    output({ ok: false, error: `bridge 没有响应（${(e as Error).message}）——先确认 bridge 在跑：claudestra doctor` });
    return;
  }
  const fallback = { ok: false, error: `bridge 返回 ${r.status} 且不是 JSON——多半还在跑没有 /relay 路由的旧版本，重启 bridge 到新代码` };
  const info = (await r.json().catch(() => fallback)) as PairInfo; // 非 JSON 响应按失败：状态码与这句提示就是全部信息
  if (!info.ok) {
    output({
      ok: false, error: info.error ?? "无法签发配对码",
      hint: "在仓库根 .env 写 RELAY_URL=wss://<中继地址>（可选 RELAY_NAME=<子域名标签>），重启 bridge 后再跑 pair",
    });
    return;
  }
  if (asJson) return output({ ...info });
  const qr = await qrToString(info.url, { type: "terminal", small: true }).catch(() => ""); // 终端不支持时只少一张二维码，链接与短码照给
  const lines = [
    `用手机相机扫码，或在任何浏览器打开下面的链接，或在 https://${info.base} 输入短码——三选一：`,
    "",
    qr.trimEnd(),
    "",
    `链接：${info.url}`,
    `短码：${info.display}`,
    "",
    `这台机器的网页：https://${info.slug}.${info.base}`,
    `${new Date(info.expiresAt).toLocaleTimeString()} 前有效，只能用一次；配对后的浏览器不用再登录。`,
  ];
  // 人看的命令，bridge 从不调它（要机器可读加 --json 走 output()）；二维码是多行文本，塞进 JSON 没人读得了
  process.stdout.write(lines.join("\n") + "\n");
}

export async function cmdRelayStatus(): Promise<void> {
  const s = await relayStatus();
  if (!s) return output({ ok: false, error: "bridge 没有响应，读不到中继状态" });
  output({ ...s });
}
