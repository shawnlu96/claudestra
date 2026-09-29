/**
 * /api/v1 的鉴权（docs/design-hosted-frontend.md §3、§5）：Bearer（peer / 脚本 / 老 token）或设备 cookie（浏览器）。
 * 设备路径：cookie 里的 token → 凭据（principals.json 只存哈希）→ 生效视图（按 grant 收窄，lib/devices.ts）；
 * 非 GET/HEAD 必须带 x-cstra-device 头（cookie 浏览器会自动附上，这个头跨站表单附不上）。
 * 限流按 principal：owner 的所有设备共用 api:owner:self 一个身份，配额相应放大。api-routes 与 web-terminal 都调这里。
 */
import { findByBearer, readPrincipals, SlidingWindowLimiter, tokenIdOf, updatePrincipals, type Principal } from "../lib/principals.js";
import { cookieValueFrom, csrfOk, DEVICE_HEADER, effectivePrincipal, findCredential, touchCredential } from "../lib/devices.js";
import { apiJson } from "./api-respond.js";
import { checkPeerSignature, peerReplayVerdict, type PeerCheck } from "./peer-signature.js";
import { requestContextOf, sourceAllows } from "./request-context.js";
import { peerSigErrorText } from "../lib/peer-auth-hints.js";
import { peerE2eRefusal, readHttpPeers } from "../lib/peer-e2e-local.js";
import { messagesOnlyAllows } from "../lib/peer-scope-gate.js";

// 120/min：默认 30 在 web 重度使用下会被打爆——SSE 重连风暴循环触发 429 → 直播流死掉（2026-07-14 真机）。owner 再放大 5 倍：
// 手机 + 电脑 + 侧栏轮询共用一个身份
const API_RATE_LIMIT_PER_MIN = 120;
const OWNER_RATE_LIMIT_PER_MIN = 600;
const limiters = new Map<string, SlidingWindowLimiter>();
const sigFailures = new Map<string, SlidingWindowLimiter>();
const SIG_FAILURE_KEYS = 2_000;
const lastTouchWrite = new Map<string, number>();
const TOUCH_WRITE_EVERY_MS = 10 * 60_000;
/** 单测把 principals.json 指到临时目录；生产不调 */
let principalsPath: string | undefined;
export function setApiAuthPrincipalsPathForTest(path: string | undefined): void {
  principalsPath = path;
}

/** Bearer 头；?token= 只对 SSE 端点放行（EventSource 不能带 header）——对全部 /api/v1 放行会让 secret 进代理日志 / 浏览历史 */
function bearerSecret(req: Request, url: URL): string | null {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (m?.[1]?.trim()) return m[1].trim();
  const sseTokenOk = req.method === "GET" && url.pathname === "/api/v1/events";
  return (sseTokenOk && url.searchParams.get("token")) || null;
}

/** peers: false = 这条路由不收 peer token（远程终端这类不限速的路由；peer 本来就不该碰终端） */
export async function authenticateApi(req: Request, url: URL, opts: { rateLimit: boolean; peers?: false }): Promise<Principal | Response> {
  const file = await readPrincipals(principalsPath);
  const secret = bearerSecret(req, url);
  let p: Principal | null;
  if (secret !== null) {
    p = findByBearer(file, secret);
    if (!p) return apiJson(401, { ok: false, error: "invalid or revoked token" });
  } else {
    const token = cookieValueFrom(req.headers.get("cookie"));
    if (token && !sourceAllows(req, "device")) return apiJson(403, { ok: false, error: "no device credentials on this entrance", code: "device_via_peer_entrance" });
    if (!token) return apiJson(401, { ok: false, error: "missing Authorization: Bearer <secret> or device cookie (only GET /events may use ?token=)" });
    const hit = findCredential(file, token);
    if (!hit) return apiJson(401, { ok: false, error: "device credential invalid, revoked or expired", code: "device_invalid" });
    if (!csrfOk(req.method, req.headers.get(DEVICE_HEADER))) return apiJson(403, { ok: false, error: `${DEVICE_HEADER} header required on non-GET requests from a device`, code: "csrf" });
    p = effectivePrincipal(hit);
    void touchLater(hit.credential.id, requestContextOf(req).clientIp);
  }
  // E2E 会话解开的内层只收 peer token：外层只证明了「是那台 peer 机器」，别的 token 借它的会话就绕过了
  // peer 入口 / 中继 peer 帧「只认 peer token」的闸（tests/peer-e2e-relay.test.ts）
  if (requestContextOf(req).e2e && !p.peer) {
    return apiJson(403, { ok: false, error: "only peer tokens are accepted inside an E2E session", code: "e2e_peer_token_required" });
  }
  if (p.peer && opts.peers === false) return apiJson(403, { ok: false, error: "peer tokens are not accepted on this route", code: "peer_route_forbidden" });
  // peer 先验签、判重放，再扣限速：拿到 token 却签不了名的人、重放截获请求的人都耗不掉正牌 peer 的额度（失败另有一个桶）
  const sig = p.peer ? await peerGate(req, url, p.peer, opts.rateLimit) : null;
  if (sig instanceof Response) return sig;
  const replay = sig?.once ? peerReplayVerdict(sig.once, p.peer!) : null;
  if (replay?.reject) return peerSigRejected(replay.reject);
  await sig?.commit();
  if (p.messagesOnly && !messagesOnlyAllows(req.method, url.pathname)) return apiJson(403, { ok: false, error: "this token may only deliver messages", code: "messages_only" });
  if (opts.rateLimit && replay?.charge !== false) {
    const limit = p.role === "owner" ? OWNER_RATE_LIMIT_PER_MIN : API_RATE_LIMIT_PER_MIN;
    const key = tokenIdOf(p);
    let limiter = limiters.get(key);
    if (!limiter) limiters.set(key, (limiter = new SlidingWindowLimiter(limit)));
    if (!limiter.tryAcquire()) return apiJson(429, { ok: false, error: `rate limit exceeded (${limit} req/min)`, code: "rate_limited", reason: "rate_limited" });
  }
  if (p.peer) {
    const peer = p.peer;
    void import("./peer-presence.js").then((m) => m.notePeerInbound(peer)); // 在线 peer 列表的「最近来访」
  }
  return p;
}

/**
 * peer token 的来源与签名：经中继来的（路径模式、隧道，source=relay）一律 403；签名钥匙必须是这个 peer 的（lib/peer-trust.ts）。
 * 验签失败也限流（每个 peer 每分钟 120 次，超了回 429），但用单独的桶：和成功请求共用一个桶的话，
 * 拿着 token 却签不了名的人就能把正牌 peer 挡在外面。
 */
async function peerGate(req: Request, url: URL, peer: string, rateLimit: boolean): Promise<Extract<PeerCheck, { allow: true }> | Response> {
  if (!sourceAllows(req, "peer")) return apiJson(403, { ok: false, error: "peer tokens are not accepted on the relay path", code: "peer_via_relay_path" });
  const e2e = peerE2eRefusal(peer, requestContextOf(req).e2e?.peerFp, await readHttpPeers()); // required peer 的明文请求、会话与 token 对不上的，都拒
  if (e2e) return apiJson(403, { ok: false, error: e2e === "e2e_required" ? "this peer must use end-to-end encryption" : "token does not belong to the session's peer", code: e2e });
  const v = await checkPeerSignature(req, url, peer);
  if (v.allow) return v;
  if (rateLimit && !sigFailureAllowed(peer)) {
    const error = `too many failed peer signatures (${API_RATE_LIMIT_PER_MIN}/min), last failure: ${v.reason}`;
    return apiJson(429, { ok: false, error, code: "peer_signature", reason: "sig_rate_limited", cause: v.reason });
  }
  return peerSigRejected(v.reason);
}

/**
 * 验签失败记一次，超了返回 false（调用方回 429）。peerGate 按 peer 名记；E2E 直连帧外层验签失败也记在这里
 * （bridge/peer-e2e-route.ts：认得出的联系人按它的名字，认不出的按来源地址）。表满了先丢最早的，丢了只是那个键的计数清零
 */
export function sigFailureAllowed(key: string): boolean {
  let failures = sigFailures.get(key);
  if (!failures) {
    if (sigFailures.size >= SIG_FAILURE_KEYS) sigFailures.delete(sigFailures.keys().next().value!);
    sigFailures.set(key, (failures = new SlidingWindowLimiter(API_RATE_LIMIT_PER_MIN)));
  }
  return failures.tryAcquire();
}

/** reason 单独给出：调用方据此提示「对时 / 重新邀请 / 别原样重发」，而不是笼统的「token 失效」 */
function peerSigRejected(reason: string): Response {
  return apiJson(401, { ok: false, error: peerSigErrorText(reason), code: "peer_signature", reason });
}

/** 凭据的 lastSeenAt / 到期滑动：内存里先节流，10 分钟内不碰 principals.json；写失败只记日志（鉴权已经通过） */
async function touchLater(credentialId: string, ip: string | null): Promise<void> {
  const now = Date.now();
  if (now - (lastTouchWrite.get(credentialId) ?? 0) < TOUCH_WRITE_EVERY_MS) return;
  lastTouchWrite.set(credentialId, now);
  try {
    // 锁内重读再改（lib/principals.ts updatePrincipals）：别拿旧副本覆盖掉并发的撤销；锁忙就跳过这次续期
    await updatePrincipals((file) => {
      const cred = file.principals.flatMap((p) => p.credentials ?? []).find((c) => c.id === credentialId);
      return { changed: !!cred && touchCredential(cred, new Date(now), ip), result: null };
    }, { path: principalsPath, waitMs: 1_000, onBusy: "skip" });
  } catch (e) {
    console.error(`⚠️ 设备凭据 ${credentialId} 记录最近使用失败: ${(e as Error).message}`);
  }
}

/** 从请求取 control token:Authorization: Bearer / x-bridge-token / ?control_token= */
export function extractControlToken(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const h = req.headers.get("x-bridge-token");
  if (h) return h.trim();
  const q = url.searchParams.get("control_token");
  return q ? q.trim() : null;
}
