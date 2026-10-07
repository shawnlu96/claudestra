/**
 * MCRY6: the auto run's last read before the merge API (scheduler-merge-driver.ts claimAndMerge, `beforeSend`) re-proves the PASS it
 * merges on: the pinned seq (its last scheduler `review_carry` of this intent ending on the run's head, same round / specRev, else its
 * own `merge_phase ready` at this head; missing, malformed or off-head refuses, no older PASS is searched) through the unchanged formal
 * gate (mergeReviewProof, injected) on the task projected by carrySourceTask (MCRY4). A throw or another seq refuses; manual_merge
 * never comes here (mergeRunDrift). tests/review-main-carry-before-send*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { carrySourceTask } from "./review-main-carry-auto-source.js";
import type { ReviewProof } from "./review-main-carry-manual-auto.js";
import type { MergeRun } from "./scheduler-merge.js";

const PREFIX = "发出前重核正式来源不成立";

/** The source review seq this run pinned at its head, or null when the ledger does not say it completely. */
function pinnedSourceSeq(db: Database, run: MergeRun, task: LedgerTask): number | null {
  const carry = listEvents(db, { project: run.project, target: run.taskId })
    .findLast((e) => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === "review_carry" && e.data.intentId === run.intentId);
  if (carry) {
    const d = carry.data;
    return d.to === run.reviewedHead && d.round === task.round && d.specRev === task.specRev && Number.isSafeInteger(d.sourceReviewSeq)
      ? d.sourceReviewSeq as number : null;
  }
  const ready = getEventByDedup(db, `scheduler:${run.intentId}:merge:ready`), d = ready?.data;
  return ready?.target === run.taskId && ready.kind === "scheduler" && d?.op === "merge_phase" && d.intentId === run.intentId &&
    d.phase === "ready" && d.head === run.reviewedHead && Number.isSafeInteger(d.reviewSeq) ? d.reviewSeq as number : null;
}

/** null = the run's pinned source still passes the formal gate now; otherwise why the merge must not be sent. */
export function sendSourceRefusal(db: Database, run: MergeRun, task: LedgerTask, workflow: TaskWorkflow, reviewProof: ReviewProof): string | null {
  try {
    const pinned = pinnedSourceSeq(db, run, task);
    if (pinned === null) return `${PREFIX}：本 run 在当前 head 钉住的来源审查读不全`;
    const facts = reviewProof(db, carrySourceTask(db, task), workflow);
    return facts.eventSeq === pinned ? null : `${PREFIX}：正式来源是 #${facts.eventSeq}，本 run 钉住的是 #${pinned}`;
  } catch (e) {
    return `${PREFIX}（来源 / 家族 / 豁免已变）：${(e as Error).message}`;
  }
}
