/** Unsent auto merge failures may release their slot; an in-flight external merge still freezes the queue. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { observeDedupKey, recoveryPolicy } from "./recovery-policy.js";
import { settleCiClaimUnsent } from "./scheduler-ci-claim-unsent.js";
import { cancelMergeRun } from "./scheduler-merge-conflict.js";
import type { MergeRun } from "./scheduler-merge.js";
import { MAIN_CI_PAUSE, MAIN_CI_UPDATE_NOT_SENT } from "./scheduler-merge-unsent-receipts.js";
export { MAIN_CI_PAUSE, MAIN_CI_UPDATE_NOT_SENT } from "./scheduler-merge-unsent-receipts.js";

/** The caller supplies its authorized event writer and transaction, just as it supplies the CAS-checked run. */
type WriteEvent = (db: Database, ctx: WriteCtx, event: {
  project: string; target: string; kind: "scheduler" | "note"; text: string; data: Record<string, unknown>;
}, primary: boolean) => LedgerEvent;
const FROZEN = "项目合并队列已冻结";
const AUTO_CANCEL = "auto 卡合并未发出，自动取消重排";
const MAIN_CI_CANCEL = "主线 CI 暂停（main_ci_pause），取消重排";
/** The driver's ready read (scheduler-merge-driver.ts): `PR 状态、base 或审查 head 已变：state/base/head`. */
const PR_MOVED = /^PR 状态、base 或审查 head 已变：([^/]*)\/([^/]*)\//;

/** A PR merged or closed elsewhere, or retargeted, is an external anomaly for PM, not an unsent attempt to retry. */
function prGone(receipt: string): boolean {
  const m = PR_MOVED.exec(receipt);
  return !!m && (m[1] !== "OPEN" || m[2] !== "main");
}

/** An earlier merging claim is conservative proof of a possible send, even if a malformed row says ready now. */
export function unsentAuto(db: Database, row: MergeRun, events: readonly LedgerEvent[], updateNotSent = false): boolean {
  const wf = getWorkflow(db, row.taskId), intent = getIntent(db, row.intentId);
  return (["ready", "await_ci"].includes(row.phase) || (updateNotSent && row.phase === "updating")) && !row.mergeSha && wf?.mode === "auto" &&
    intent?.action === "merge" && intent.status === "submitted" && intent.node !== "manual_merge" &&
    !events.some((e) => e.kind === "scheduler" && e.data.op === "merge_phase" && e.data.intentId === row.intentId &&
      [e.data.phase, e.data.from, e.data.to].some((p) => p === "merging" || p === "merged"));
}

/** Called only on → unknown after manual/UI exits and before drift; false leaves the old unknown path byte-for-byte intact. */
export function unsentEnd(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string | undefined, write: WriteEvent): boolean {
  receipt = receipt?.trim();
  // main_ci_pause is sent only by the gate under mainCiPause=on; it cancels whatever mergeUnsentCancel says (its own switch, PM 定 3)
  const pause = !!receipt?.startsWith(`${MAIN_CI_PAUSE}：`);
  const mode = pause ? "on" : recoveryPolicy(row.project, "mergeUnsentCancel").mode;
  if (mode === "off") return false;
  if (!receipt || receipt.length > 600 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(receipt) || prGone(receipt)) return false;
  const events = listEvents(db, { project: row.project, target: row.taskId });
  if (!unsentAuto(db, row, events, pause && receipt.startsWith(MAIN_CI_UPDATE_NOT_SENT))) return false;
  const now = ctx.now ?? Date.now();
  if (mode === "observe") {
    const action = { project: row.project, mechanism: "mergeUnsentCancel" as const, target: row.taskId, actionKey: row.intentId };
    const dedupKey = observeDedupKey(action);
    if (!getEventByDedup(db, dedupKey)) write(db, { actor: "scheduler", now, dedupKey }, {
      project: row.project, target: row.taskId, kind: "note", text: `恢复观察（mergeUnsentCancel）：本会取消、不冻结:${receipt}`.slice(0, 600),
      data: { op: "recovery_observe", mechanism: action.mechanism, actionKey: action.actionKey, intentId: row.intentId, phase: row.phase, head: row.reviewedHead, receipt },
    }, true);
    return false;
  }
  cancelMergeRun(db, { ...ctx, now }, row, receipt, pause ? MAIN_CI_CANCEL : AUTO_CANCEL);
  // A separate marker distinguishes these cancellations from PM/UI cancellations without changing their historical events.
  const marker = write(db, { ...ctx, now, dedupKey: `scheduler:${row.intentId}:merge:unsent` }, {
    project: row.project, target: row.taskId, kind: "scheduler", text: `${pause ? "主线 CI 暂停，" : ""}未发出合并，取消且不冻结：${receipt}`.slice(0, 600),
    data: { op: "merge_unsent_cancel", intentId: row.intentId, head: row.reviewedHead, phase: row.phase,
      specRev: getIntent(db, row.intentId)!.specRev, receipt, counted: receipt !== FROZEN && !pause, ...(pause ? { cause: MAIN_CI_PAUSE } : {}) },
  }, true);
  // CLAIMSPENT1: a CI recovery claim the gate stopped before its send is settled unsent in this same transaction (ciClaimUnsent)
  if (pause) settleCiClaimUnsent(db, { ...ctx, now }, row, receipt, marker, write);
  return true;
}
