import { localSharedLedgerPlanningAllowed, readSharedLedgerMode } from "./shared-ledger-mode.js";
import { centerClaimCommitted } from "./shared-ledger-center-claims.js";
import { LedgerError } from "./ledger-store.js";

/** Re-read durable authority at each side effect; a preflight result is not an execution grant. */
export function sharedLedgerPlanningReason(featureId: string): string | null {
  try {
    const mode = readSharedLedgerMode(featureId);
    if (localSharedLedgerPlanningAllowed(mode)) return null;
    if (mode.centerPlanned) return `feature ${featureId} 是中心副本：规划在中心，本机不能改图、绑卡或开新节点；只有已在中心认领的卡和节点能开工`;
    return `feature ${featureId} 已迁入共享规划：本机不能改图、绑卡或开新节点，请在团队规划页操作；已有卡继续原授权流程`;
  } catch {
    // Invalid authority state must fail closed without disclosing credential or filesystem details.
    return `feature ${featureId} 的共享规划状态无法核验，暂停本机改图与开新节点`;
  }
}

export function requireLocalSharedLedgerPlanning(featureId: string): void {
  const why = sharedLedgerPlanningReason(featureId);
  if (why) throw new LedgerError("forbidden", why);
}

/** N7X1: a center replica opens only the card and node its committed claim names (preflight, runStart steps, task-new, dag-bind). */
export function requireSharedLedgerStart(featureId: string, key: string, taskId: string | (() => string)): void {
  const why = sharedLedgerPlanningReason(featureId);
  if (!why) return;
  let ok = false;
  try { ok = !!readSharedLedgerMode(featureId).centerPlanned && centerClaimCommitted(featureId, key, typeof taskId === "string" ? taskId : taskId()); }
  catch { ok = false; } // Unreadable claims or an unnameable card fail closed with the planning text.
  if (!ok) throw new LedgerError("forbidden", why);
}
