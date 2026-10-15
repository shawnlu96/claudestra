/**
 * Local merge, ledger side (ONB-2, docs/architecture/local-merge.md): a localMerge project has no PR, so the auto tick stops a
 * card at `merge` with one `local_merge_ready` record and the PM merges it into local main with `ledger local-merge`
 * (lib/local-merge-run.ts does the git). Every write here rechecks the ledger in its own transaction; nothing here runs git.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { mergeReviewProof } from "./scheduler-merge.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

const LOCAL_MERGE_OP = "local_merge";
const LOCAL_READY_OP = "local_merge_ready";
const LOCAL_NOTIFIED_OP = "local_merge_notified";
const SHA = /^[a-f0-9]{40}$/i;

/** How the commit that lands on main was made; `backfill` = the head was already on main, only the record was missing. */
export type LocalMergeMode = "ff" | "merge" | "backfill";
export interface CheckResult { check: string; code: number | null; timedOut: boolean; ms: number }
export interface LocalMergeInput { taskId: string; head: string; mergeSha: string; base: string; mode: LocalMergeMode; checks: CheckResult[] }

/**
 * The card's latest entry into `merge`: ready, notice and merge records belong to one stay there, so a card that goes live → fix →
 * review → merge again on the same head is merged again, not answered with the first stay's record.
 */
const mergeEntry = (db: Database, task: LedgerTask): number =>
  listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;
const recordKey = (db: Database, task: LedgerTask, head: string): string => `local-merge:${task.id}:s${mergeEntry(db, task)}:${head.toLowerCase()}`;
const readyKey = (db: Database, task: LedgerTask, head: string): string => `scheduler:${LOCAL_READY_OP}:${task.id}:s${mergeEntry(db, task)}:${head.toLowerCase()}`;
const noticeKey = (db: Database, task: LedgerTask, head: string): string => `${readyKey(db, task, head)}:notified`;

/** PM (not the dispatcher) / master / owner of the card's project: checked before anything is read back or written. */
export function assertMayLocalMerge(db: Database, actor: string, task: LedgerTask): void {
  if (!actorMayConfigure(db, actor, task.project)) throw new LedgerError("forbidden", `本地合并要项目 ${task.project} 的 PM（调度助理除外）/ master / owner（你是 ${actor}）`);
}

/** This stay's local_merge record at this head, if one was written: a rerun returns it instead of merging again. */
export const localMergeRecord = (db: Database, task: LedgerTask, head: string): LedgerEvent | null => getEventByDedup(db, recordKey(db, task, head));

/** Where the card's current head stands in this stay: no ready record, ready but the PM notice not confirmed sent, or notified. */
export function localReadyState(db: Database, task: LedgerTask): "none" | "ready" | "notified" {
  if (!task.headSHA || !getEventByDedup(db, readyKey(db, task, task.headSHA))) return "none";
  return getEventByDedup(db, noticeKey(db, task, task.headSHA)) ? "notified" : "ready";
}

/**
 * Scheduler only. Ready: an auto card in `merge` at its full head that the PM could merge right now (same gate as local-merge, minus
 * the caller) waits for the PM; one record per stay and head. Notified: the receipt after the PM notice went out, so a notice that
 * failed is sent again on the next pass or after a restart, and one that went out is not. A replay returns the first record.
 */
export function recordLocalReady(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; notified?: boolean }): { event: LedgerEvent; duplicate: boolean } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "本地合并就绪只由调度服务记");
  return tx(db, () => {
    const task = mustTask(db, input.taskId), workflow = getWorkflow(db, task.id), now = ctx.now ?? Date.now();
    if (task.stage !== "merge" || workflow?.mode !== "auto") throw new LedgerError("conflict", "任务不在自动流程的 merge 阶段");
    if (!SHA.test(input.head) || task.headSHA !== input.head) throw new LedgerError("conflict", "就绪的 head 不是任务当前的完整 head");
    const key = input.notified ? noticeKey(db, task, input.head) : readyKey(db, task, input.head), prev = getEventByDedup(db, key);
    if (prev) return { event: prev, duplicate: true };
    if (input.notified && !getEventByDedup(db, readyKey(db, task, input.head))) throw new LedgerError("conflict", "还没记本地合并就绪");
    if (!input.notified) mergeableNow(db, task, workflow, input.head, now);
    const text = input.notified ? `已通知 PM 本地合并 ${task.id}` : `审查通过，等 PM 本地合并：ledger local-merge ${task.id} --head ${input.head}`;
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler", text,
      data: { op: input.notified ? LOCAL_NOTIFIED_OP : LOCAL_READY_OP, head: input.head } }, true);
    return { event, duplicate: false };
  });
}

/** This round's review at the card's head: an auto card's full merge proof, a manual card's own round review with no P0/P1. */
function reviewOf(db: Database, task: LedgerTask, workflow: TaskWorkflow): ReviewFacts {
  if (workflow.mode === "auto") {
    if (workflow.specRev !== task.specRev) throw new LedgerError("conflict", "规格版本已变，审查不覆盖");
    return mergeReviewProof(db, task, workflow);
  }
  const read = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }), (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts" || !["pass", "changes"].includes(read.facts.verdict) || read.facts.findings.some((f) => f.severity !== "P2")) {
    throw new LedgerError("conflict", "本轮没有通过的审查结论（或仍有 P0/P1）");
  }
  return read.facts;
}

/** Whether this card may merge at this head now: in `merge`, head = ledger head = the head this round's review passed, UI accepted, queue not frozen. */
function mergeableNow(db: Database, task: LedgerTask, workflow: TaskWorkflow | null, head: string, now: number): ReviewFacts {
  if (task.kind !== "code" || task.stage !== "merge") throw new LedgerError("conflict", `卡在 ${task.stage}，不在 merge`);
  if (!workflow) throw new LedgerError("conflict", "卡没有流程记录");
  if (!SHA.test(head) || task.headSHA?.toLowerCase() !== head.toLowerCase()) {
    throw new LedgerError("conflict", `--head 不是台账 head（${task.headSHA?.slice(0, 12) ?? "空"}），要完整 SHA`);
  }
  if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("conflict", "项目合并队列已冻结");
  const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
  if (ui) throw new LedgerError("conflict", `UI 验收：${ui}`);
  const review = reviewOf(db, task, workflow);
  if (review.head.toLowerCase() !== head.toLowerCase()) throw new LedgerError("conflict", `本轮通过审查的是 ${review.head.slice(0, 12)}，不是这个 head`);
  return review;
}

/** Who may merge (PM, not the dispatcher / master / owner) and whether this card at this head may merge now. Throws the reason; writes nothing. */
export function localMergeGate(db: Database, actor: string, taskId: string, head: string, now: number): { task: LedgerTask; review: ReviewFacts } {
  const task = mustTask(db, taskId);
  assertMayLocalMerge(db, actor, task);
  return { task, review: mergeableNow(db, task, getWorkflow(db, task.id), head, now) };
}

/**
 * After main moved to the merged commit: one local_merge record (head, merge commit, main before, checks) and merge → live in one
 * transaction, file locks released as on every move to live. A replay returns the first record.
 */
export function recordLocalMerge(db: Database, ctx: WriteCtx, input: LocalMergeInput): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const current = mustTask(db, input.taskId);
    assertMayLocalMerge(db, ctx.actor, current);
    const prev = localMergeRecord(db, current, input.head);
    if (prev) return { event: prev, duplicate: true };
    if (![input.mergeSha, input.base].every((s) => SHA.test(s))) throw new LedgerError("invalid", "合并提交和基线要是完整 SHA");
    const now = ctx.now ?? Date.now();
    const { task, review } = localMergeGate(db, ctx.actor, input.taskId, input.head, now);
    const move = canTransition(task, "live", "pm");
    if (!move.ok) throw new LedgerError("conflict", move.reason);
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: recordKey(db, task, input.head) }, { project: task.project, target: task.id,
      kind: "decision", text: `本地合并进 main：${input.head.slice(0, 12)} → ${input.mergeSha.slice(0, 12)}（${input.mode}）`,
      data: { op: LOCAL_MERGE_OP, head: input.head, mergeSha: input.mergeSha, base: input.base, mode: input.mode, checks: input.checks,
        reviewSeq: review.eventSeq } }, true);
    const next = nextTaskState(task, "live");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: `本地合并 ${input.mergeSha.slice(0, 12)}，进入 live`,
      data: { from: "merge", to: "live", round: next.round, specRev: next.specRev, head: input.head, mergeSha: input.mergeSha, localMergeSeq: event.seq } }, false);
    releaseFinishedCardLeases(db, task.id);
    return { event, duplicate: false };
  });
}
