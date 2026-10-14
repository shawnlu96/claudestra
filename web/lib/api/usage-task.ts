import { api } from "./client";

export type UsageFamily = "claude" | "codex";
export interface TaskUsageSummary {
  families: Partial<Record<UsageFamily, { totalTokens: number }>>;
  totalTokens: number;
  hasArchive: boolean;
  detailFrom: string | null;
  unavailableBefore: string | null;
  lent: Partial<Record<UsageFamily, { orders: number; tokensReported: boolean; unreportedOrders?: number }>>;
  weekEstimate: Partial<Record<UsageFamily, { estimatePct: number | null }>>;
}
export function fetchTaskUsage(id: string, signal?: AbortSignal): Promise<{ ok: boolean; summary: TaskUsageSummary }> {
  return api(`/usage/task/${encodeURIComponent(id)}`, { signal });
}
