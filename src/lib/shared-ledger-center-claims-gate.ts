/**
 * task-new gate for center replicas (ledger-write.ts createTask). Non-replica features keep requireSharedLedgerTaskPlanning
 * verbatim; a replica card passes only with a committed claim for (feature, card), and then the full
 * requireSharedLedgerStart(feature, key, card) check runs with the claim's node key. dag-bind later re-checks the node.
 */
import { committedCenterClaimFor } from "./shared-ledger-center-claims.js";
import { requireSharedLedgerStart } from "./shared-ledger-gate.js";
import { readSharedLedgerMode, requireSharedLedgerTaskPlanning } from "./shared-ledger-mode.js";
import { LedgerError } from "./ledger-store.js";

export function requireSharedLedgerTaskStart(extra: Record<string, unknown> | undefined, taskId: string): void {
  try { requireSharedLedgerTaskPlanning(extra); return; }
  catch (error) {
    if (!(error instanceof LedgerError) || error.code !== "forbidden") throw error;
    const featureId = String(extra?.sharedFeatureId);
    let claim;
    try { claim = readSharedLedgerMode(featureId).centerPlanned ? committedCenterClaimFor(featureId, taskId) : null; }
    catch { claim = null; } // Unverifiable state keeps the original refusal.
    if (!claim) throw error;
    requireSharedLedgerStart(featureId, claim.key, taskId);
  }
}
