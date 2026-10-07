/**
 * MCRY6: the auto run's last read before the merge API (scheduler-merge-driver.ts claimAndMerge, `beforeSend`) re-proves the PASS the
 * run is merging on, not just "the current head still reads a passing review". The owner may withdraw a MODELX same-family exemption
 * (or anything else the formal gate reads) after the `merging` claim committed; the claim's own transaction cannot see that.
 * - pinned: the source seq this run proved — its last `review_carry` (scheduler-written, this intent, ending on the run's head, same
 *   round / specRev), or with no carry its own `merge_phase ready` event at this head. Missing, malformed or off-head refuses; no
 *   search for any older PASS.
 * - re-proved: the unchanged formal gate (mergeReviewProof, injected: this leaf may not import scheduler-merge.ts back) on the task
 *   projected onto the source head by the trusted chain (carrySourceTask, MCRY4): order / gen / session / family / ticket / claim /
 *   the exemption's current approval. A throw or another seq refuses; a manual_merge run never comes here (mergeRunDrift).
 * tests/review-main-carry-before-send*.test.ts.
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
