import { localSharedLedgerPlanningAllowed, readSharedLedgerMode } from "./shared-ledger-mode.js";
import { LedgerError } from "./ledger-store.js";

/** Re-read durable authority at each side effect; a preflight result is not an execution grant. */
export function sharedLedgerPlanningReason(featureId: string): string | null {
  try {
    if (localSharedLedgerPlanningAllowed(readSharedLedgerMode(featureId))) return null;
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
