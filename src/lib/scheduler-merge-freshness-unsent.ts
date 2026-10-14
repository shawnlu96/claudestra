/**
 * dispatch-recovery-MRGFRESH1 (PM 定 1): the ledger side of the driver's post-claim main refusal on an auto card. The run
 * is at `merging`, which normally means "a merge may have been sent" and freezes the queue; here the sending controller
 * itself attests, before the merge call and under its lease and the run's CAS, that nothing went out. Such a run is
 * cancelled without a freeze and marked like any unsent auto cancellation (scheduler-merge-unsent.ts), so the planner
 * requeues the card and the next attempt reads the branch as behind from `ready` and refreshes it.
 *
 * Narrow on purpose: only the two driver receipts (scheduler-merge-freshness-receipts.ts), only this intent's first and
 * last claim (one `merging` event, nothing journalled after it), never a manual card (manualUnsentAtSend owns that) and
 * never a row with a merge SHA. A `merging` row seen after a restart is settled by mergingStep with another receipt and
 * still freezes. The owner's mergeUnsentCancel switch applies as it does to every unsent cancellation.
 */
import type { Database } from "bun:sqlite";
import { cancelMergeRun } from "./scheduler-merge-conflict.js";
import type { MergeRun } from "./scheduler-merge.js";
import { CLAIM_MAIN_CAUSE, claimMainUnsent } from "./scheduler-merge-freshness-receipts.js";
import { observeDedupKey, recoveryPolicy } from "./recovery-policy.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import type { insertEvent } from "./ledger-tx.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent } from "./ledger-stages.js";

const CLAIM_CANCEL = "auto 卡领取 merging 后 main 已变，合并未发出，自动取消重排";

/** This intent's journal holds exactly one claim, it is the last phase move, and nothing ever reached merged. */
function onlyClaim(events: readonly LedgerEvent[], row: MergeRun): boolean {
  const moves = events.filter((e) => e.kind === "scheduler" && e.data.op === "merge_phase" && e.data.intentId === row.intentId && e.data.imported !== true);
  const claims = moves.filter((e) => [e.data.phase, e.data.from, e.data.to].some((p) => p === "merging" || p === "merged"));
  return claims.length === 1 && claims[0] === moves.at(-1) && claims[0]!.data.to === "merging";
}

function eligible(db: Database, row: MergeRun, receipt: string): boolean {
  const wf = getWorkflow(db, row.taskId), intent = getIntent(db, row.intentId);
  return row.phase === "merging" && !row.mergeSha && receipt.length <= 600 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(receipt) &&
    claimMainUnsent(receipt) && wf?.mode === "auto" && intent?.action === "merge" && intent.status === "submitted" &&
    intent.node !== "manual_merge" && onlyClaim(listEvents(db, { project: row.project, target: row.taskId }), row);
}

/** Called on merging → unknown after the existing unsent exits; false leaves the old freeze path untouched. */
export function claimMainUnsentEnd(db: Database, ctx: WriteCtx, row: MergeRun, raw: string | undefined, write: typeof insertEvent): boolean {
  const receipt = raw?.trim() ?? "";
  if (row.phase !== "merging" || !eligible(db, row, receipt)) return false;
  const mode = recoveryPolicy(row.project, "mergeUnsentCancel").mode;
  if (mode === "off") return false;
  const now = ctx.now ?? Date.now(), own = { project: row.project, target: row.taskId };
  const facts = { intentId: row.intentId, head: row.reviewedHead, phase: row.phase, receipt, cause: CLAIM_MAIN_CAUSE };
  if (mode === "observe") { // record only, as scheduler-merge-unsent.ts does under observe; the old freeze stands
    const dedupKey = observeDedupKey({ ...own, mechanism: "mergeUnsentCancel", actionKey: row.intentId });
    if (getEventByDedup(db, dedupKey)) return false;
    write(db, { actor: "scheduler", now, dedupKey }, { ...own, kind: "note", text: `恢复观察（mergeUnsentCancel）：本会取消、不冻结:${receipt}`.slice(0, 600),
      data: { op: "recovery_observe", mechanism: "mergeUnsentCancel", actionKey: row.intentId, ...facts } }, true);
    return false;
  }
  cancelMergeRun(db, { ...ctx, now }, row, receipt, CLAIM_CANCEL);
  // Same marker shape as scheduler-merge-unsent.ts; `cause` is what lets the retry planner accept a merging-phase cancellation.
  write(db, { ...ctx, now, dedupKey: `scheduler:${row.intentId}:merge:unsent` }, { ...own, kind: "scheduler",
    text: `领取 merging 后 main 已变，未发出合并，取消且不冻结：${receipt}`.slice(0, 600),
    data: { op: "merge_unsent_cancel", ...facts, specRev: getIntent(db, row.intentId)!.specRev, counted: true } }, true);
  return true;
}
