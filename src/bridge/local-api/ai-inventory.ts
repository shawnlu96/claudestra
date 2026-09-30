/**
 * GET /api/v1/ai-inventory（T91）：本机 AI 能力清单，给网页后续用，本卡不做界面。
 * 只给全权设备：canAdministerPairing = 全 scope、非 peer、manage，且必须是设备凭据——额度看板那道门（canSeeQuota）过渡期还放行
 * 老的全 scope Bearer token，这份清单有订阅额度、本机路径与第三方主机，不跟着放。见 tests/local-api-ai-inventory.test.ts。
 * 只读、只接 GET；生成要跑三次 `--version` 并扫会话记录尾部，30 秒内复用上一份（并发请求共用同一次生成）。
 */
import { canAdministerPairing } from "../../lib/devices.js";
import type { AiInventory } from "../../lib/ai-inventory.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";

const CACHE_MS = 30_000;
let cache: { at: number; value: Promise<AiInventory> } | null = null;

/** 单测注入；生产不调 */
export function setAiInventoryForTest(v: AiInventory | null): void {
  cache = v ? { at: Number.POSITIVE_INFINITY, value: Promise.resolve(v) } : null;
}

function inventory(now: number): Promise<AiInventory> {
  if (cache && (cache.at === Number.POSITIVE_INFINITY || now - cache.at < CACHE_MS)) return cache.value;
  const value = import("../../lib/ai-inventory.js").then((m) => m.collectAiInventory());
  cache = { at: now, value };
  value.catch(() => { if (cache?.value === value) cache = null; }); // 失败不缓存：下次请求重试；错误本身由路由回 500 并记日志
  return value;
}

export async function handleAiInventoryApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/ai-inventory") return null;
  if (!canAdministerPairing(principal)) return forbidden("ai inventory requires a full-scope owner device credential");
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  try {
    return apiJson(200, { ok: true, ...(await inventory(Date.now())) });
  } catch (e) {
    console.error("[ai-inventory] 生成失败:", (e as Error).message);
    return apiJson(500, { ok: false, error: "ai inventory unavailable" });
  }
}
