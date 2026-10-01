/** 出借方管理面的接口包装（bridge local-api/lend-grant.ts），一律经 lib/api/client */
import { api, ApiError } from "@/lib/api/client";
import type { LendData, OrderView } from "./lend-model";

/** null = 这台机器不给看（非 owner 本人全权凭据 403，或 bridge 太旧没有这条接口 404）：整个面板不渲染 */
export async function fetchLend(): Promise<LendData | null> {
  try {
    return await api<LendData>("/lend/grants");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

export interface CliResult { ok: boolean; error?: string; warning?: string; message?: string }

/** 授权：CLI 的原话在 ApiError.message（失败）或 warning / message（成功）里 */
export function postGrant(body: { peer: string; repos: string[]; codex?: number; claude?: number; ordersPerDay: number; until: string }): Promise<CliResult> {
  return api<CliResult>("/lend/grants", { method: "POST", json: body });
}

export function postRevoke(peer: string): Promise<CliResult & { orders: OrderView[] }> {
  return api<CliResult & { orders: OrderView[] }>("/lend/grants/revoke", { method: "POST", json: { peer } });
}
export const claudeTokenApi = (method = "GET", token?: string) =>
  api<{ configured: boolean; savedAt: string | null }>("/lend/claude-token", { method, ...(token === undefined ? {} : { json: { token } }) });
