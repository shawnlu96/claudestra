/**
 * The repository owner's P1 sends a handed-over card back to fix (RRL-2). An auto card in `merge` — before the handoff or while
 * following it — whose current head has a booked, unconsumed owner P1 (remoteP1At) goes merge → fix through the same stage-event
 * shape as a merge bounce (`mergeBounce.cause = "remote_review"`), so the planner, take_order and the targeted re-review all read
 * it as one. Its own count: the 4th, or a head a lender wrote, goes to PM instead. Elsewhere (build / fix outside a bounce, a
 * manual card PM moved to fix) the report only rides along on the order (remoteFixWork, remote-review-current.ts). tests/remote-review-bounce*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { remoteP1At, remoteP1Of } from "./remote-review-current.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { MAX_MERGE_BOUNCES, remoteBounceCount, type MergeBounce, type RemoteBounce } from "./scheduler-merge-conflict.js";
import { handoffCard, handoffOf } from "./scheduler-merge-handoff.js";

const BOUNCE_OP = "remote_bounce";
const bounceKey = (taskId: string, seq: number): string => `scheduler:${BOUNCE_OP}:${taskId}:${seq}`;

/**
 * An owner P1 on the head this merge stay is about that has not bounced it yet: once handed over, only the head the handoff follows
 * now (after a carry the card's own head is an old PR head, and a late review of it never acts); before, the card's head.
 */
export interface PendingRemoteBounce { head: string; remote: RemoteBounce }
export function pendingRemoteBounce(db: Database, task: LedgerTask): PendingRemoteBounce | null {
  if (task.stage !== "merge" || !task.headSHA) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  const head = handoffOf(db, task)?.head ?? task.headSHA, e = remoteP1At(events, head, task.pr);
  return e && !getEventByDedup(db, bounceKey(task.id, e.seq)) ? { head, remote: remoteP1Of(e) } : null;
}

/** Why this P1 goes to PM instead of bouncing (null = bounce): a lender wrote the head, or the owner's bounces are used up. */
export function remoteBounceRefusal(db: Database, task: LedgerTask, p: PendingRemoteBounce): string | null {
  const where = `仓库方审查 ${p.remote.reportId} 有 ${p.remote.p1} 个 P1；报告：${p.remote.reportPath}`;
  if (remoteHeadFamily(db, task)) return `${where}。这个 head 是出借方写的，不自动退回 fix，请 PM 接手`;
  const count = remoteBounceCount(listEvents(db, { project: task.project, target: task.id })) + 1;
  return count > MAX_MERGE_BOUNCES ? `${where}。这是仓库方第 ${count} 次打回，不再自动退回 fix，请 PM 接手` : null;
}

/**
 * Scheduler only: merge → fix for the pending owner P1 `remoteSeq`, rechecked in the transaction (auto card in merge on its spec, at
 * this head and PR, the P1 still the current word on the head, no refusal). A replay returns the first record.
 */
export function recordRemoteBounce(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; remoteSeq: number }):
  { event: LedgerEvent; duplicate: boolean } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "仓库方打回退 fix 只由调度服务记");
  return tx(db, () => {
    const key = bounceKey(input.taskId, input.remoteSeq), prev = getEventByDedup(db, key);
    if (prev) return { event: prev, duplicate: true };
    const { task } = handoffCard(db, ctx, input);
    const p = pendingRemoteBounce(db, task);
    if (p?.remote.seq !== input.remoteSeq) throw new LedgerError("conflict", `远端审查事件 ${input.remoteSeq} 不是这个 head 当前未处理的仓库方 P1`);
    const refused = remoteBounceRefusal(db, task, p);
    if (refused) throw new LedgerError("conflict", refused);
    const move = canTransition(task, "fix", "pm");
    if (!move.ok) throw new LedgerError("conflict", move.reason);
    const now = ctx.now ?? Date.now(), next = nextTaskState(task, "fix");
    const bounce: MergeBounce = { cause: "remote_review", prHead: p.head, mainHead: null, checks: [], remote: p.remote };
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage",
      text: `仓库方审查 ${p.remote.reportId} 有 P1，退回 fix`,
      data: { from: "merge", to: "fix", round: next.round, specRev: next.specRev, head: task.headSHA, mergeBounce: bounce } }, false);
    const count = remoteBounceCount(listEvents(db, { project: task.project, target: task.id }));
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `仓库方审查 ${p.remote.reportId} 打回，退回 fix（第 ${count} 次）`,
      data: { op: BOUNCE_OP, remoteSeq: p.remote.seq, reportId: p.remote.reportId, head: p.head, count } }, true);
    return { event, duplicate: false };
  });
}
