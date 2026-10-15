/** Main CI uses the existing gate and slot-turn CAS: a manual run waits in place while its slot serves the repair. */
import type { Database } from "bun:sqlite";
import { decide, mainCiGateOf, type MainCiGate } from "./scheduler-main-ci-wiring-gate.js";
import { mainCiApprovals, mainCiLent, mainCiPms } from "./scheduler-main-ci-wiring-store.js";
import { getTask } from "./ledger-store.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { ownerReadConnection, queueOwnerMode } from "./merge-queue-owner-context.js";
import type { MergeRun } from "./scheduler-merge.js";
import type { MainCiDecision } from "./scheduler-merge-driver.js";

export function ownerMainCiPaused(db: Database, project: string, taskId: string, head: string): boolean {
  const gate = mainCiGateOf(ownerReadConnection(db));
  return !!gate && decide(gate, project, taskId, head) === "pause";
}
/** The slot hook yields before the driver. Keep the same manual intent; never cancel/requeue it on a pause. */
export function ownerMainCiDecision(gate: MainCiGate, run: MergeRun): MainCiDecision | null {
  return queueOwnerMode(gate.db, run.project) === "on" && run.intentId.startsWith("mmq:") &&
    ownerMainCiPaused(gate.db, run.project, run.taskId, run.reviewedHead) ? "wait" : null;
}

/** A durable pause loan reserves the repair's turn across the pass/claim processes. An old binding alone has no priority. */
function hasPausedLoan(db: Database, project: string): boolean {
  const live = db.query("SELECT id FROM scheduler_intents WHERE project = ? AND action = 'merge' AND status IN ('pending','submitted')")
    .all(project) as { id: string }[];
  return live.some(({ id }) => {
    if (mainCiLent(db, project, id)) return true;
    const last = db.query(`SELECT json_extract(data, '$.turn') AS turn, json_extract(data, '$.receipt') AS receipt FROM events
      WHERE project = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = 'merge_slot'
      AND json_extract(data, '$.intentId') = ? ORDER BY seq DESC LIMIT 1`).get(project, id) as { turn: string; receipt: string } | null;
    return last?.turn === "yield" && typeof last.receipt === "string" && last.receipt.includes("mergeQueueOwner：主线 CI 暂停");
  });
}
/** Persisted PM bindings order repairs ahead of a paused lender in the claim child too; the driver still verifies main/fault. */
export function ownerRepairs(db: Database, project: string, repo: string): Set<string> {
  if (recoveryPolicy(project, "mainCiPause").mode !== "on" || !hasPausedLoan(db, project)) return new Set();
  const approvals = mainCiApprovals(db, project, repo), pms = mainCiPms(db, project, approvals);
  return new Set(approvals.filter((a) => {
    const task = getTask(db, a.binding.taskId);
    return pms.includes(a.actor) && task?.project === project && task.stage === "merge" && task.headSHA === a.binding.head;
  }).map((a) => a.binding.taskId));
}
export { mainCiLent };
