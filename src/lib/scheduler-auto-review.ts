/**
 * Who may write a verdict on an auto card, and what it may not do. The card's ledger-bound reviewer session records its
 * own structured verdict (it is not in the PM list, so without this it could not write at all); nobody moves an auto
 * card with `review --to`, because the engine decides the next stage from the verdict. PM takes a card back with
 * `workflow-set --mode manual --reason` first.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

export function refuseAutoReviewMove(db: Database, task: Pick<LedgerTask, "id">, move: unknown): void {
  if (move && getWorkflow(db, task.id)?.mode === "auto") {
    throw new LedgerError("forbidden", `${task.id} 是自动卡：审查只记结论，不带 --to，阶段由调度器推；要人工推先 workflow-set --mode manual --reason`);
  }
}

/** The bound, active reviewer session writing about itself, with the structured fields that name that session. */
export function isBoundAutoReviewer(db: Database, task: Pick<LedgerTask, "id">, actor: string,
  claim: { reviewer?: string; session?: string; family?: string }): boolean {
  if (getWorkflow(db, task.id)?.mode !== "auto") return false;
  const bound = getSchedulerSession(db, task.id, "reviewer");
  return !!bound && bound.state === "active" && bound.agent === actor && claim.reviewer === actor &&
    claim.session === bound.sessionId && claim.family === bound.family;
}
