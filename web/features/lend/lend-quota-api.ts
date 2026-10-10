/** 出借额度线的接口包装（bridge local-api/lend-quota-lines.ts），一律经 lib/api/client */
import { api, ApiError } from "@/lib/api/client";
import type { LineMode, QuotaFamily, QuotaLinesView } from "./lend-quota-model";

/** null = 这台机器不给看（非 owner 全权凭据 403，或 bridge 太旧没有这条接口 404）：设置块不渲染 */
export async function fetchQuotaLines(): Promise<QuotaLinesView | null> {
  try {
    return await api<QuotaLinesView>("/lend/quota-lines");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

/** 保存：成功回最新视图（以它为准刷新界面）；失败抛 ApiError，message 是 bridge 的原因 */
export function postQuotaLines(body: { family: QuotaFamily; warnPct: number; stopPct: number } | { mode: LineMode }): Promise<QuotaLinesView> {
  return api<QuotaLinesView>("/lend/quota-lines", { method: "POST", json: body });
}
