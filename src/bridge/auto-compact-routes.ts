/**
 * /api/v1/auto-compact（从 api-routes 拆出：那个文件只许变小）：自动存记忆 + compact 的全局线、闲置门槛、93% 救命线，
 * 以及上下文边界新增自动压缩的开关 inject（具名策略和大总管，缺省关；关着时全局线和救命线照旧，docs/architecture/context-boundary.md）。
 * 写 Claudestra 自己的 config.json（CC 的 settings.json 会拒未知字段）。读写都要全权凭据。
 */
import { readConfig, setAutoCompact } from "../lib/config-store.js";
import type { Principal } from "../lib/principals.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, isFullScope, readJsonBody } from "./api-respond.js";

async function state() {
  const cfg = await readConfig();
  return {
    ok: true,
    // window：0 = 关闭；null = 未设（用默认）
    window: cfg.autoCompact?.window ?? null,
    idleHours: cfg.autoCompact?.idleHours ?? null,
    // 93% 救命线独立开关（缺省开；常规线 window=0 时仍兜底）
    emergency: cfg.autoCompact?.emergency !== false,
    inject: cfg.autoCompact?.inject === true,
    defaults: { window: 400_000, idleHours: 3, emergency: true, emergencyRatio: 0.93, inject: false },
  };
}

export async function handleAutoCompactRoute(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/auto-compact") return null;
  if (!isFullScope(principal)) return forbidden("auto-compact config requires a full-scope token");
  if (req.method === "GET") return apiJson(200, await state());
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const patch: { window?: number; idleHours?: number; emergency?: boolean; inject?: boolean } = {};
  if (body.emergency !== undefined) patch.emergency = Boolean(body.emergency);
  // 开关打开就开始往 agent 窗口里敲键：只收真正的布尔值，"false" 这类字符串不能被读成打开
  if (body.inject !== undefined) {
    if (typeof body.inject !== "boolean") return apiJson(400, { ok: false, error: "inject must be true or false" });
    patch.inject = body.inject;
  }
  if (body.window !== undefined) {
    const w = Number(body.window);
    if (!Number.isFinite(w) || w < 0 || w > 10_000_000) {
      return apiJson(400, { ok: false, error: "window must be 0..10000000 tokens" });
    }
    patch.window = w;
  }
  if (body.idleHours !== undefined) {
    const h = Number(body.idleHours);
    if (!Number.isFinite(h) || h < 0 || h > 168) {
      return apiJson(400, { ok: false, error: "idleHours must be 0..168" });
    }
    patch.idleHours = h;
  }
  if (!Object.keys(patch).length) return apiJson(400, { ok: false, error: "nothing to set" });
  await setAutoCompact(patch);
  return apiJson(200, await state());
}
