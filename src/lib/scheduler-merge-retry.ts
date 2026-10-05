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

const MODE_OPS = ["workflow", "workflow_resume", "fallback_manual"];
const modeEvent = (e: LedgerEvent): boolean => e.kind === "scheduler" && MODE_OPS.includes(String(e.data.op));
/** Same text the planner's merge_retry_requires_pm escalation hands to scheduler-fallback-manual for this intent */
const retryFallbackReason = (intent: SchedulerIntent) => `merge_retry_requires_pm：合并意图 ${intent.id} 已取消，`;

/** The intent was planned inside this round's merge stage and nothing moved the card since. */
function enteredThisRound(task: LedgerTask, events: readonly LedgerEvent[], intent: SchedulerIntent): boolean {
  const entered = events.findLast((e) => e.seq <= intent.causalSeq && e.kind === "stage" && e.data.to === "merge");
  return !!entered && entered.data.round === task.round &&
    !events.some((e) => e.seq > intent.eventSeq && (e.kind === "stage" || e.kind === "deliver"));
}

/** PM's own manual takeover through workflow-set (the writer checks PM / master / owner); never a hold, the scheduler or an import. */
function pmPause(pause: LedgerEvent | undefined, intent: SchedulerIntent): pause is LedgerEvent {
  return !!pause && pause.data.op === "workflow" && pause.data.mode === "manual" && pause.data.manual === true &&
    pause.data.specRev === intent.specRev && pause.data.templateVersion === intent.templateVersion &&
    Number.isInteger(pause.data.workflowRev) && typeof pause.data.takeover === "string" && pause.data.hold === undefined &&
    pause.actor !== "scheduler" && pause.data.imported !== true;
}

/**
 * Every mode change after the pause, in order and rev by rev: a PM workflow-resume after the cancellation, then only
 * [scheduler fallback for this very cancelled intent → another PM workflow-resume] pairs, ending on a PM resume. Any other
 * takeover, fallback, hold or gap needs its own fresh handback. These events are emitted only after the existing writers
 * check project PM/master/owner (resume) or scheduler/PM (fallback) permission. task.pm is display-only.
 */
function handedBack(events: readonly LedgerEvent[], intent: SchedulerIntent, pause: LedgerEvent, cancelledSeq: number): boolean {
  const chain = events.filter((e) => e.seq > pause.seq && modeEvent(e));
  if (!chain.length || chain[0].seq <= cancelledSeq || chain.length % 2 !== 1) return false;
  let rev = Number(pause.data.workflowRev);
  return chain.every((e, n) => {
    if (e.data.imported === true || e.data.workflowRev !== ++rev) return false;
    if (n % 2 === 1) {
      return e.actor === "scheduler" && e.data.op === "fallback_manual" && e.data.from === "auto" && e.data.manual === undefined &&
        e.data.intentId === null && Array.isArray(e.data.cancelledIntents) && e.data.cancelledIntents.length === 0 &&
        String(e.data.reason ?? "").startsWith(retryFallbackReason(intent));
    }
    return e.actor !== "scheduler" && e.data.op === "workflow_resume" && e.data.manual === true && e.data.from === "manual" &&
      e.data.stage === "merge" && e.data.specRev === intent.specRev && e.data.fromSpecRev === intent.specRev;
  });
}

/**
 * A merge intent PM's workflow-set cancelled while still pending: planned by the scheduler, never settled, journaled, carried or
 * otherwise referenced afterwards, cancelled by that pause itself (cancelledIntents), then handed back.
 */
function pendingCancellation(task: LedgerTask, events: readonly LedgerEvent[], intent: SchedulerIntent): LedgerEvent | undefined {
  const plan = events.find((e) => e.seq === intent.eventSeq);
  if (!plan || plan.kind !== "scheduler" || plan.actor !== "scheduler" || plan.data.op !== "plan" || plan.data.id !== intent.id ||
    plan.data.action !== "merge" || plan.dedupKey !== `scheduler:${intent.id}`) return;
  if (!enteredThisRound(task, events, intent)) return;
  const pause = events.find((e) => e.seq > plan.seq && modeEvent(e));
  if (!pmPause(pause, intent) || !Array.isArray(pause.data.cancelledIntents) || !pause.data.cancelledIntents.includes(intent.id)) return;
  const names = (v: unknown) => v === intent.id || (Array.isArray(v) && v.includes(intent.id));
  if (events.some((e) => e.seq > plan.seq && e !== pause && Object.values(e.data).some(names))) return;
  if (!intent.head || !task.headSHA || !sameSha(intent.head, task.headSHA)) return;
  return handedBack(events, intent, pause, pause.seq) ? pause : undefined;
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
  if (!enteredThisRound(task, events, intent)) return;
  const pause = own.findLast(modeEvent);
  if (!pmPause(pause, intent) || !handedBack(events, intent, pause, terminal.seq)) return;
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
    e.data.op === "workflow_resume" && e.data.manual === true) :
    !!(pausedCancellation(task, events, cancelled) ?? pendingCancellation(task, events, cancelled));
  return resumed && headReachable(events, cancelled, task.headSHA);
}
