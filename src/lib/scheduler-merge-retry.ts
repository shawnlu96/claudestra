/** A release belongs to one cancelled intent: a later cancellation needs another explicit handback. */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";

const sameSha = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** 被取消意图审过的 head 经它自己的 review_carry 链（调度器写的）走到卡上 head 才算纯 main 合入 */
function headReachable(events: readonly LedgerEvent[], intent: SchedulerIntent, cardHead: string): boolean {
  if (!intent.head) return false;
  let head = intent.head;
  for (const e of events) {
    if (e.kind !== "scheduler" || e.data.op !== "review_carry" || e.data.intentId !== intent.id || e.actor !== "scheduler") continue;
    if (typeof e.data.from === "string" && typeof e.data.to === "string" && sameSha(e.data.from, head)) head = e.data.to;
  }
  return sameSha(head, cardHead);
}

/** Only the journal's terminal cancellation of a paused, unsent merge qualifies; receipt prose is not authority. */
function pausedCancellation(task: LedgerTask, events: readonly LedgerEvent[], intent: SchedulerIntent): LedgerEvent | undefined {
  const terminal = events.findLast((e) => e.kind === "scheduler" && e.data.op === "merge_phase" && e.data.intentId === intent.id);
  if (!terminal || terminal.actor !== "scheduler" || terminal.dedupKey !== `scheduler:${intent.id}:merge:cancelled` ||
    terminal.data.to !== "resolved" || terminal.data.outcome !== "cancelled" ||
    !["ready", "updating", "await_ci"].includes(String(terminal.data.from))) return;
  const own = events.filter((e) => e.seq >= intent.eventSeq && e.seq < terminal.seq);
  const phases = own.filter((e) => e.kind === "scheduler" && e.data.op === "merge_phase" && e.data.intentId === intent.id);
  const ready = phases[0];
  if (!ready || ready.actor !== "scheduler" || ready.dedupKey !== `scheduler:${intent.id}:merge:ready` ||
    ready.data.phase !== "ready" || ready.data.head !== intent.head || !Number.isInteger(ready.data.reviewSeq)) return;
  if (phases.some((e) => e.actor !== "scheduler" || (e !== ready && !["updating", "await_ci"].includes(String(e.data.to)))) ||
    (phases.at(-1)?.data.to ?? "ready") !== terminal.data.from) return;
  const settled = own.at(-1);
  if (!settled || settled.kind !== "scheduler" || settled.actor !== "scheduler" || settled.data.op !== "settle" ||
    settled.dedupKey !== `scheduler:${intent.id}:cancelled` || settled.data.id !== intent.id ||
    settled.data.from !== "submitted" || settled.data.to !== "cancelled" || settled.seq + 1 !== terminal.seq) return;
  const entered = events.findLast((e) => e.seq <= intent.causalSeq && e.kind === "stage" && e.data.to === "merge");
  if (!entered || entered.data.round !== task.round || events.some((e) => e.seq > intent.eventSeq &&
    (e.kind === "stage" || e.kind === "deliver"))) return;
  const pause = own.findLast((e) => e.kind === "scheduler" && ["workflow", "workflow_resume", "fallback_manual"].includes(String(e.data.op)));
  if (!pause || pause.data.op !== "workflow" || pause.data.mode !== "manual" || pause.data.manual !== true ||
    pause.data.specRev !== intent.specRev || pause.data.templateVersion !== intent.templateVersion ||
    !Number.isInteger(pause.data.workflowRev) || typeof pause.data.takeover !== "string" || pause.data.hold !== undefined ||
    pause.actor === "scheduler" || pause.data.imported === true) return;
  // These events are emitted only after the existing writer checks project PM/master/owner permissions. task.pm is display-only.
  const resume = events.findLast((e) => e.kind === "scheduler" && ["workflow", "workflow_resume", "fallback_manual"].includes(String(e.data.op)));
  if (!resume || resume.seq <= terminal.seq || resume.data.op !== "workflow_resume" || resume.data.manual !== true ||
    resume.actor === "scheduler" || resume.data.imported === true || resume.data.from !== "manual" || resume.data.stage !== "merge" ||
    resume.data.specRev !== intent.specRev || resume.data.fromSpecRev !== intent.specRev ||
    resume.data.workflowRev !== Number(pause.data.workflowRev) + 1) return;
  let head = intent.head;
  for (const c of own.filter((e) => e.kind === "scheduler" && e.data.op === "review_carry" && e.data.intentId === intent.id)) {
    const paired = phases.some((e) => e.seq === c.seq + 1 && e.data.carrySeq === c.seq && e.data.to === "await_ci");
    if (!paired || c.actor !== "scheduler" || c.data.round !== task.round || c.data.specRev !== intent.specRev ||
      c.data.from !== head || typeof c.data.to !== "string" || !/^[a-f0-9]{40}$/i.test(c.data.to)) return;
    head = c.data.to;
  }
  if (!head || !task.headSHA || !sameSha(head, task.headSHA)) return;
  return terminal;
}

/** 这个被取消的合并意图是否已由 PM 核对（failed / cancelled）并在之后交回自动 */
export function mergeRetryReleased(task: LedgerTask, events: readonly LedgerEvent[], cancelled: SchedulerIntent): boolean {
  if (cancelled.action !== "merge" || cancelled.status !== "cancelled" || !task.headSHA ||
    cancelled.taskId !== task.id || cancelled.project !== task.project || cancelled.specRev !== task.specRev) return false;
  events = events.filter((e) => e.project === task.project && e.target === task.id && e.data.imported !== true);
  const resolve = events.findLast((e) => e.kind === "scheduler" && e.data.op === "merge_resolve" && e.data.intentId === cancelled.id &&
    e.data.manual === true && e.actor !== "scheduler");
  const legacy = resolve && (resolve.data.outcome === "failed" || resolve.data.outcome === "cancelled");
  const resumed = legacy ? events.some((e) => e.kind === "scheduler" && e.seq > resolve.seq &&
    e.data.op === "workflow_resume" && e.data.manual === true) : !!pausedCancellation(task, events, cancelled);
  return resumed && headReachable(events, cancelled, task.headSHA);
}
