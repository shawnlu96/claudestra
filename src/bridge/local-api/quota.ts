/**
 * 订阅额度（设计稿 T2b §1 / §5；接线在 bridge/quota-service.ts）：
 *   GET  /api/v1/quota                  { ok, enabled, snapshot: QuotaSnapshot, health }——同时是「有人在看」的心跳
 *   POST /api/v1/quota/retry {provider}  用户主动重试（Keychain 被拒 / 端点暂停后只认这个）→ { ok, result }
 *   GET/PUT /api/v1/quota/settings       { enabled }：从订阅接口读实时额度的开关（缺省开）
 * 全部只给本机 owner（canSeeQuota = 全 scope、非 peer 的 manage 凭据）：账户用量、重置次数、读凭据的开关都是 owner 的。
 * 动态 import：quota-service 拖着全机用量子进程与 bridge/config，本地 API 其余端点族的单测不该为它付加载代价（同 control.ts）。
 * 响应里只有白名单 DTO（百分比、重置时刻、次数、HMAC 过的键）与固定错误码，没有凭据、邮箱、原始账户 id。
 */
import { canSeeQuota } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";

const PATHS = new Set(["/quota", "/quota/retry", "/quota/settings"]);
const unavailable = () => apiJson(503, { ok: false, error: "quota service not running" });

export async function handleQuotaApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (!PATHS.has(path)) return null;
  if (!canSeeQuota(principal)) return forbidden("subscription quota requires a full-scope owner credential");
  const svc = (await import("../quota-service.js")).quotaService();
  if (!svc) return unavailable();
  if (path === "/quota") {
    if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
    return apiJson(200, { ok: true, ...(await svc.snapshot()) });
  }
  if (path === "/quota/retry") {
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    const body = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const p = (body as { provider?: unknown } | null)?.provider;
    if (p !== "claude" && p !== "codex") return apiJson(400, { ok: false, error: 'provider must be "claude" or "codex"' });
    return apiJson(200, { ok: true, result: await svc.retry(p) });
  }
  if (req.method === "GET") return apiJson(200, { ok: true, enabled: svc.isEnabled() });
  if (req.method !== "PUT") return apiJson(405, { ok: false, error: "method not allowed" });
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") return apiJson(400, { ok: false, error: "enabled must be a boolean" });
  await svc.setEnabled(enabled);
  return apiJson(200, { ok: true, enabled: svc.isEnabled() });
}
