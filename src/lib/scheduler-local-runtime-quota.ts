/** Reuses the inventory's existing Codex quota observations; unknown/newly reset windows never invent usage. */
import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import type { SlotWait } from "./scheduler-local-runtime-slots.js";

export type CodexQuotaReader = () => Promise<InventoryQuota>;
const readCodexQuota: CodexQuotaReader = async () => (await readInventoryQuota()).codex;

export async function codexQuotaWait(read: CodexQuotaReader = readCodexQuota, now = Date.now()): Promise<SlotWait | null> {
  let q: InventoryQuota;
  try { q = await read(); }
  catch (e) {
    // Like the existing Claude quota gate, an unavailable snapshot does not stop scheduling; worker failures still report quota errors.
    console.error(`[scheduler-local-runtime] Codex 额度读不到，本轮不拦：${(e as Error).message}`);
    return null;
  }
  if (q.status !== "known") return null;
  const over = q.windows.find((w) => (w.kind === "weekly" || w.kind === "weekly_scoped") && !w.resetPassed
    && (w.resetsAtMs === null || w.resetsAtMs > now) && w.usedPct !== null && Number.isFinite(w.usedPct) && w.usedPct >= 85);
  return over ? { kind: "wait", reason: `Codex 周额度 ${over.id} 已用 ${over.usedPct}%，达到 85% 线，等待窗口重置` } : null;
}
