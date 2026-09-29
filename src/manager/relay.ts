/**
 * manager 侧的中继相关（bridge/relay-routes.ts 的回环路由是它的后端）：
 *   - `claudestra pair` 在 manager/pair.ts（签码、打印 grant、等手输短码的确认）；
 *   - `claudestra relay-status`：中继连接状态；
 *   - peerCliFetch：peer 命令里对 relay:// 地址的 fetch 替身——只有 bridge 持有中继连接，manager 请它代调。
 */
import { bridgeHttpBase } from "../lib/bridge-port.js";
import { instanceKeySync, keyFingerprint, signedFor } from "../lib/instance-key.js";
import { createE2eOutbound, defaultOutboundDeps } from "../lib/peer-e2e-outbound.js";
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

type CliFetchInit = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal };
/** 发往 required peer 的一律包进 E2E 会话（lib/peer-e2e-outbound.ts）；外层签名由下面的传输层加（直连这里签、中继由 bridge 签） */
const e2eOutbound = createE2eOutbound(defaultOutboundDeps());

/** manager 的 peer 调用唯一出口：required peer 走 E2E（走不了就抛错，绝不退回明文），其余明文照旧 */
export async function peerCliFetch(url: string, init: CliFetchInit = {}): Promise<Response> {
  const viaE2e = await e2eOutbound.fetch(url, init, (u, outer) => rawCliFetch(u, { ...outer, ...(init.signal ? { signal: init.signal } : {}) }));
  return viaE2e ?? rawCliFetch(url, init);
}

/** 传输层：relay://<指纹>/… 交给 bridge 经中继代调（POST /relay/request，bridge 签名），其余加上实例签名直接 fetch——对方只认签名钥匙对得上的 peer */
async function rawCliFetch(url: string, init: CliFetchInit): Promise<Response> {
  const m = /^relay:\/\/([^/]+)(\/.*)?$/i.exec(url);
  const to = m ? relayPeerFingerprint(`relay://${m[1]}`) : null;
  if (!m || !to) return fetch(url, { ...init, headers: { ...init.headers, ...signedFor(init.method ?? "GET", url, init.body ?? "") } } as RequestInit);
  const bytes = typeof init.body === "string" ? new TextEncoder().encode(init.body) : (init.body ?? new Uint8Array(0));
  const r = await fetch(`${bridgeHttpBase()}/relay/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, method: init.method ?? "GET", path: m[2] || "/", headers: init.headers ?? {}, ...(bytes.length ? { body: b64.enc(bytes) } : {}) }),
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

export async function cmdRelayStatus(): Promise<void> {
  const s = await relayStatus();
  if (!s) return output({ ok: false, error: "bridge 没有响应，读不到中继状态" });
  output({ ...s });
}
