/** CVREBOR1 read-side check, kept free of ledger-lend imports so order hydration (readReborrowBasis) stays acyclic. */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import type { ReborrowFacts } from "./lend-reborrow-facts.js";

export const CONV_REBORROW_OP = "write_reborrow_conv";

/**
 * Read-side verification after commit: the historical CONV evidence in the persisted facts must still be the exact ledger rows.
 * Liveness checks are not repeated here (the successor itself is live), only immutable identity.
 */
export function convEvidenceIntact(db: Database, f: ReborrowFacts): boolean {
  const c = f.conv;
  if (!c) return false;
  const same = (e: LedgerEvent) => !!e.dedupKey && JSON.stringify(getEventByDedup(db, e.dedupKey)) === JSON.stringify(e);
  const intentId = f.reclaim.data.intentId;
  const intent = db.query("SELECT * FROM scheduler_intents WHERE id = ?").get(String(intentId)) as Record<string, unknown> | null;
  return same(f.reclaim) && same(c.materials) && c.material?.path === c.materials.data.material && c.cancels.every(same) && c.proofs.every(same) &&
    f.reclaim.dedupKey === `scheduler:${intentId}:reclaim` && f.reclaim.data.op === "fix_strategy_reclaim" &&
    f.reclaim.data.family === c.to && f.family === c.to && f.previous.family === c.from && c.from !== c.to &&
    !!intent && intent.id === c.intent.id && intent.action === "fix_swap" && intent.taskId === f.task.id &&
    ["done", "cancelled"].includes(String(intent.status)) &&
    f.lease.state === "ended" && f.lease.reason === f.reclaim.data.reason && f.lease.updatedAt === f.reclaim.ts;
}
