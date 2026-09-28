/**
 * /api/v1 的鉴权（docs/design-hosted-frontend.md §3、§5）：Bearer（peer / 脚本 / 老 token）或设备 cookie（浏览器）。
 * 设备路径：cookie 里的 token → 凭据（principals.json 只存哈希）→ 生效视图（按 grant 收窄，lib/devices.ts）；
 * 非 GET/HEAD 必须带 x-cstra-device 头（cookie 浏览器会自动附上，这个头跨站表单附不上）。
 * 限流按 principal：owner 的所有设备共用 api:owner:self 一个身份，配额相应放大。api-routes 与 web-terminal 都调这里。
 */
import { findByBearer, readPrincipals, SlidingWindowLimiter, tokenIdOf, updatePrincipals, type Principal } from "../lib/principals.js";
import { cookieValueFrom, csrfOk, DEVICE_HEADER, effectivePrincipal, findCredential, touchCredential } from "../lib/devices.js";
import { apiJson } from "./api-respond.js";
import { checkPeerSignature } from "./peer-signature.js";
import { requestContextOf } from "./request-context.js";
import { FP_RE } from "../lib/relay-protocol.js";

// 120/min：默认 30 在 web 重度使用下会被打爆——SSE 重连风暴循环触发 429 → 直播流死掉（2026-07-14 真机）。owner 再放大 5 倍：
// 手机 + 电脑 + 侧栏轮询共用一个身份
const API_RATE_LIMIT_PER_MIN = 120;
const OWNER_RATE_LIMIT_PER_MIN = 600;
const limiters = new Map<string, SlidingWindowLimiter>();
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

export async function authenticateApi(req: Request, url: URL, opts: { rateLimit: boolean }): Promise<Principal | Response> {
  const file = await readPrincipals(principalsPath);
  const secret = bearerSecret(req, url);
  let p: Principal | null;
  if (secret !== null) {
    p = findByBearer(file, secret);
    if (!p) return apiJson(401, { ok: false, error: "invalid or revoked token" });
  } else {
    const token = cookieValueFrom(req.headers.get("cookie"));
    if (!token) return apiJson(401, { ok: false, error: "missing Authorization: Bearer <secret> or device cookie (only GET /events may use ?token=)" });
    const hit = findCredential(file, token);
    if (!hit) return apiJson(401, { ok: false, error: "device credential invalid, revoked or expired", code: "device_invalid" });
    if (!csrfOk(req.method, req.headers.get(DEVICE_HEADER))) return apiJson(403, { ok: false, error: `${DEVICE_HEADER} header required on non-GET requests from a device`, code: "csrf" });
    p = effectivePrincipal(hit);
    void touchLater(hit.credential.id, requestContextOf(req).clientIp);
  }
  if (opts.rateLimit) {
    const limit = p.role === "owner" ? OWNER_RATE_LIMIT_PER_MIN : API_RATE_LIMIT_PER_MIN;
    const key = tokenIdOf(p);
    let limiter = limiters.get(key);
    if (!limiter) limiters.set(key, (limiter = new SlidingWindowLimiter(limit)));
    if (!limiter.tryAcquire()) return apiJson(429, { ok: false, error: `rate limit exceeded (${limit} req/min)` });
  }
  if (p.peer) {
    // peer 只经 peer 入口或中继的 peer 帧进来；路径模式（source=relay）是给浏览器的，token 在那里只是中继看得见的明文
    if (requestContextOf(req).source === "relay") return apiJson(403, { ok: false, error: "peer tokens are not accepted on the relay path", code: "peer_via_relay_path" });
    const v = await checkPeerSignature(req, url, p.peer); // 签名钥匙必须是这个 peer 的（lib/peer-trust.ts）
    if (!v.allow) return apiJson(401, { ok: false, error: `peer request signature rejected: ${v.reason}`, code: "peer_signature" });
    const peer = p.peer;
    void import("./peer-presence.js").then((m) => m.notePeerInbound(peer)); // 在线 peer 列表的「最近来访」
  }
  return p;
}

/** 经中继来的请求的发件人指纹：只认 peer 入口核过进程内标记后放进请求上下文的（peer-ingress.ts），原始头一律不信；没有返回 "" */
export function relaySenderFp(req: Request): string {
  const fp = requestContextOf(req).relayFrom ?? "";
  return FP_RE.test(fp) ? fp : "";
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
