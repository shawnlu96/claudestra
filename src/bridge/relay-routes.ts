/**
 * bridge 主端口上的回环控制路由（只有本机能到，bridge.ts 的闸门已保证），给 manager CLI 与本机 Web 用：
 *   POST /peer-ingress/sync        manager 生成直连邀请前让 peer 入口立刻对外（peer-ingress.ts）
 *   GET  /relay/status             中继连接状态 + 联系人在线（relay-link.ts）
 *   POST /relay/pair/new           签配对短码 → { code, display, url, base, slug, expiresAt }（`claudestra pair`）
 *   POST /relay/pair/redeem {code} Web 的 /api/auth/pair 拿用户输入的码来换会话 → { ok, username }
 *   POST /relay/request {to,…}     manager 的 peer 命令经中继调对方（bridge 才有中继连接，manager 是另一个进程）
 */
import { userInfo } from "node:os";
import { FP_RE, formatCode, normalizeHeaders } from "../lib/relay-protocol.js";
import { RelayError } from "../lib/relay-client.js";
import { b64, collectBody } from "../lib/relay-stream.js";
import { peerIngressSyncRoute } from "./peer-ingress.js";

/** bridge.ts 只从这一个模块 import 控制路由相关的东西（它在 guard 基线里只许缩，多一行 import 都不行） */
export { initPeerIngress } from "./peer-ingress.js";
import { relayClient, relayInfo } from "./relay-link.js";
import { activePairingCodes, issuePairingCode, redeemPairingCode } from "./relay-pairing.js";

const MAX_CLI_RESPONSE = 8 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const v = await req.json().catch(() => null); // 空 body / 坏 JSON 都按空对象：各路由自己报缺哪个字段
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function notConnected(): Response {
  const i = relayInfo();
  const why = !i.enabled ? "本机 .env 没配 RELAY_URL" : `中继未连上（${i.state ?? "unknown"}${i.lastError ? `: ${i.lastError}` : ""}）`;
  return json(409, { ok: false, error: why, ...i });
}

function pairNew(): Response {
  const c = relayClient();
  const i = relayInfo();
  if (!c || !i.connected || !i.url) return notConnected();
  const { code, expiresAt } = issuePairingCode(c);
  return json(200, { ok: true, code, display: formatCode(code), url: `${i.url}/pair#${code}`, base: i.base, slug: i.slug, expiresAt: new Date(expiresAt).toISOString() });
}

async function pairRedeem(req: Request): Promise<Response> {
  const body = await readJson(req);
  const input = typeof body.code === "string" ? body.code : "";
  if (!input) return json(400, { ok: false, error: '"code" required' });
  const r = redeemPairingCode(relayClient(), input);
  if (r.ok) return json(200, { ok: true, username: userInfo().username });
  if (r.reason === "rate_limited") return json(429, { ok: false, error: "too many attempts, wait a minute", reason: r.reason });
  return json(400, { ok: false, error: r.reason === "expired" ? "code expired" : "code invalid", reason: r.reason });
}

/** manager 经中继调对方：正文 base64 进出，整读（CLI 的响应都是小 JSON） */
async function relayRequest(req: Request): Promise<Response> {
  const c = relayClient();
  if (!c || !relayInfo().connected) return notConnected();
  const body = await readJson(req);
  const to = typeof body.to === "string" ? body.to.toLowerCase() : "";
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  const path = typeof body.path === "string" ? body.path : "";
  if (!FP_RE.test(to) || !path.startsWith("/")) return json(400, { ok: false, error: '"to" must be a fingerprint and "path" must start with /' });
  const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined;
  try {
    const r = await c.request(to, { method, path, headers: normalizeHeaders(body.headers), body: typeof body.body === "string" ? b64.dec(body.body) : null }, { timeoutMs });
    const bytes = await collectBody(r.body, MAX_CLI_RESPONSE);
    return json(200, { ok: true, status: r.status, headers: r.headers, body: b64.enc(bytes) });
  } catch (e) {
    if (e instanceof RelayError) return json(502, { ok: false, code: e.code, origin: e.origin, error: e.message });
    return json(502, { ok: false, code: "local_error", error: (e as Error).message });
  }
}

export async function relayControlRoutes(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/peer-ingress/sync" && req.method === "POST") return peerIngressSyncRoute(req);
  if (p === "/relay/status" && req.method === "GET") {
    return json(200, { ok: true, ...relayInfo(), peers: relayClient()?.peers() ?? [], pairingCodes: activePairingCodes() });
  }
  if (p === "/relay/pair/new" && req.method === "POST") return pairNew();
  if (p === "/relay/pair/redeem" && req.method === "POST") return pairRedeem(req);
  if (p === "/relay/request" && req.method === "POST") return relayRequest(req);
  return json(404, { ok: false, error: `unknown control route ${req.method} ${p}` });
}
