/**
 * 订阅额度（设计稿 T2b §1 / §5；接线在 bridge/quota-service.ts）：
 *   GET  /api/v1/quota                  { ok, enabled, snapshot: QuotaSnapshot, health }——同时是「有人在看」的心跳
 *   POST /api/v1/quota/retry {provider}  用户主动重试（Keychain 被拒 / 端点暂停后只认这个）→ { ok, result }
 *   GET/PUT /api/v1/quota/settings       { enabled }：从订阅接口读实时额度的开关（缺省开）
 *   GET  /api/v1/quota/wall             额度闸（bridge/quota-wall.ts）：{ ok, active, wall, queued }——网页顶部横幅 30 秒拉一次
 *   POST /api/v1/quota/wall/clear        人工确认额度已恢复（同 manager quota-wall clear）→ { ok, cleared }
 *   POST /api/v1/quota/codex/reset-credit {creditKey}  使用一张 Codex 重置卡（真实消费，lib/quota-consume.ts）→ { ok, result }；409 = 已有一次在途
 * 全部只给本机 owner（canSeeQuota = 全 scope、非 peer 的 manage 凭据）：账户用量、重置次数、读凭据的开关都是 owner 的。
 * 用卡再严一道（canSpendQuota）：只认 owner 本人的设备凭据，老的全 scope Bearer、guest、peer 都不放。
 * 动态 import：quota-service 拖着全机用量子进程与 bridge/config，本地 API 其余端点族的单测不该为它付加载代价（同 control.ts）。
 * 响应里只有白名单 DTO（百分比、重置时刻、次数、HMAC 过的键）与固定错误码，没有凭据、邮箱、原始账户 id。
 */
import { canAdministerPairing, canSeeQuota, OWNER_PRINCIPAL_ID } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import type { QuotaService } from "../quota-service.js";

const CONSUME_PATH = "/quota/codex/reset-credit";
const PATHS = new Set(["/quota", "/quota/retry", "/quota/settings", "/quota/wall", "/quota/wall/clear", CONSUME_PATH]);
const unavailable = () => apiJson(503, { ok: false, error: "quota service not running" });

/** 用重置卡不可逆：与网页确认团队变更（bridge/team-confirm.ts canConfirmTeam）同一道门——owner 本人、全权、设备凭据 */
const canSpendQuota = (p: Principal): boolean => canAdministerPairing(p) && p.id === OWNER_PRINCIPAL_ID;

export async function handleQuotaApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (!PATHS.has(path)) return null;
  if (!canSeeQuota(principal)) return forbidden("subscription quota requires a full-scope owner credential");
  if (path.startsWith("/quota/wall")) return handleWall(req, path);
  if (path === CONSUME_PATH && !canSpendQuota(principal)) return forbidden("using a reset credit requires the owner's own device credential");
  const svc = (await import("../quota-service.js")).quotaService();
  if (!svc) return unavailable();
  if (path === CONSUME_PATH) return consume(req, svc);
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

/** creditKey 是 GET /quota 里那张卡的 HMAC 键（32 位 hex），不给 = 最早到期的那张可用卡 */
async function consume(req: Request, svc: QuotaService): Promise<Response> {
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const key = (body as { creditKey?: unknown } | null)?.creditKey ?? null;
  if (key !== null && (typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key))) return apiJson(400, { ok: false, error: "creditKey must be a key from GET /quota" });
  const result = await svc.consumeCodexReset(key);
  if (result.status === "busy") return apiJson(409, { ok: false, error: "another reset is already in progress", result });
  return apiJson(200, { ok: true, result });
}

/** 额度闸不依赖额度服务（服务关着时闸照样靠撞墙原文与到点工作），单独取 */
async function handleWall(req: Request, path: string): Promise<Response> {
  const wall = (await import("../quota-wall-wiring.js")).quotaWall();
  if (!wall) return apiJson(503, { ok: false, error: "quota wall not running" });
  if (path === "/quota/wall/clear") {
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    return apiJson(200, { ok: true, cleared: wall.clear() });
  }
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  const { active, wall: w, queued, queuedHuman } = wall.snapshot();
  const credits = active ? ((await (await import("../quota-service.js")).quotaService()?.claudeWall(false))?.credits ?? null) : null; // 只读快照，不触发查询
  return apiJson(200, {
    ok: true, active, queued, queuedHuman, credits,
    wall: w && {
      kind: w.kind, enteredAt: w.enteredAt, resetsAt: w.resetsAt, resetsText: w.resetsText, agents: Object.values(w.hits).map((h) => h.agent),
      probeDown: !!w.probeDown, exit: w.exit ?? null, recovering: !!w.exit && w.recovery?.step !== "done",
    },
  });
}
