/** Pure journal proof for retries: no policy reread can turn an old ambiguous cancellation into an unsent one. */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";

export const UNSENT_BOUNCE_LIMIT_REASON = "同一 head 连续三次未发出合并就取消，请 PM 核对 GitHub 并排期";

const sameHead = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const own = (e: LedgerEvent, task: LedgerTask): boolean => e.project === task.project && e.target === task.id && e.data.imported !== true;

/** Marker, terminal and settlement are adjacent writes in advanceMergeRun's transaction, never receipt prose alone. */
function cancellation(events: readonly LedgerEvent[], marker: LedgerEvent): boolean {
  const d = marker.data;
  if (marker.kind !== "scheduler" || d.op !== "merge_unsent_cancel" || typeof d.intentId !== "string" || typeof d.counted !== "boolean" ||
    marker.dedupKey !== `scheduler:${d.intentId}:merge:unsent` || !["ready", "await_ci"].includes(String(d.phase))) return false;
  const terminal = events.find((e) => e.seq === marker.seq - 1), settle = events.find((e) => e.seq === marker.seq - 2);
  return !!terminal && !!settle && [terminal, settle].every((e) => e.kind === "scheduler" && e.actor === marker.actor && e.ts === marker.ts &&
    e.project === marker.project && e.target === marker.target && e.data.imported !== true) &&
    terminal.dedupKey === `scheduler:${d.intentId}:merge:cancelled` && terminal.data.op === "merge_phase" &&
    terminal.data.intentId === d.intentId && terminal.data.from === d.phase && terminal.data.to === "resolved" && terminal.data.outcome === "cancelled" &&
    settle.dedupKey === `scheduler:${d.intentId}:cancelled` && settle.data.op === "settle" && settle.data.id === d.intentId &&
    settle.data.from === "submitted" && settle.data.to === "cancelled" && (marker.actor === "scheduler" || settle.data.manual === true);
}

/** Head evidence can change away and back between retries; a successful merge or a PM resume also ends the cancellation streak. */
function resets(e: LedgerEvent, head: string): boolean {
  const d = e.data;
  if (e.kind === "scheduler" && d.op === "merge_phase" && d.to === "merged") return true;
  if (e.kind === "scheduler" && d.op === "merge_resolve" && d.outcome === "done") return true;
  // PM's own hand-back after checking GitHub restarts the count; the scheduler's automatic resumes never do.
  if (e.kind === "scheduler" && d.op === "workflow_resume" && d.manual === true && e.actor !== "scheduler") return true;
  const patch = d.patch as Record<string, unknown> | undefined;
  if (e.kind === "task" && patch && Object.hasOwn(patch, "headSHA") && patch.headSHA === null) return true;
  const observed = e.kind === "task" ? patch?.headSHA : e.kind === "deliver" ? d.headSHA : e.kind === "stage" ? d.head :
    e.kind === "scheduler" && d.op === "review_carry" ? d.to :
    e.kind === "scheduler" && (d.op === "merge_unsent_cancel" || d.op === "merge_phase" && d.phase === "ready") ? d.head : null;
  return typeof observed === "string" && !sameHead(observed, head);
}

function countSinceReset(events: readonly LedgerEvent[], head: string): number {
  let count = 0;
  for (const e of events) {
    if (resets(e, head)) count = 0;
    if (e.data.counted === true && sameHead(e.data.head, head) && cancellation(events, e)) count++;
  }
  return count;
}

/** The existing planner keeps its old cancellation rules for other runs. Collateral releases never trigger the limit. */
export function unsentRetryPlan(events: readonly LedgerEvent[], cancelled: SchedulerIntent | undefined, task: LedgerTask): "other" | "retry" | "limit" {
  if (!cancelled || cancelled.action !== "merge" || cancelled.status !== "cancelled" || cancelled.taskId !== task.id ||
    cancelled.project !== task.project || cancelled.specRev !== task.specRev) return "other";
  events = events.filter((e) => own(e, task));
  const marker = events.findLast((e) => e.data.op === "merge_unsent_cancel" && e.data.intentId === cancelled.id);
  const head = task.headSHA;
  if (!head || !marker || marker.seq <= cancelled.eventSeq || marker.data.specRev !== task.specRev ||
    !sameHead(marker.data.head, head) || !cancellation(events, marker)) return "other";
  return marker.data.counted === true && countSinceReset(events, head) >= 3 ? "limit" : "retry";
}
