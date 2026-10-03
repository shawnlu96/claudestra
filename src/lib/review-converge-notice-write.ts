/**
 * The write half of the failed follow-up notice (review-converge-notice.ts followUpFailureNotice): the auto tick reads a
 * query_only connection, so once PM got the notice it records "informed" through `ledger scheduler-converge-notice`
 * (manager/ledger-converge-notice-cmds.ts) under the scheduler identity. Inside one immediate transaction the command re-checks
 * the lease, then that the seq is this card's own review_downgrade with a followUpFailure, at the round / head the caller saw.
 * Same dedupKey, text and data as the event the tick used to write directly; a repeat writes nothing.
 * tests/review-converge-notice-readonly.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, LedgerError, toEvent } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { followUpKey } from "./review-converge-followup.js";

export const convergeNoticeKey = (taskId: string, downgradeSeq: number): string => `scheduler:converge-notice:${taskId}:${downgradeSeq}`;

export function followUpFailureText(taskId: string, e: Pick<LedgerEvent, "data">): string {
  return `[调度引擎] ${taskId} 第 ${e.data.round} 轮降级发现的后续节点未建立，请 PM 补建：${e.data.followUpFailure}；报告 ${e.data.reportPath}`;
}

/** A downgrade this card's notice may close: the card's own review_downgrade (its round's dedupKey) that failed its follow-up. */
export const isFailedFollowUp = (task: Pick<LedgerTask, "id" | "project">, e: LedgerEvent): boolean =>
  e.project === task.project && e.target === task.id && e.kind === "scheduler" && e.data.op === "review_downgrade" &&
  typeof e.data.followUpFailure === "string" && typeof e.data.round === "number" && e.dedupKey === followUpKey(task.id, e.data.round);

export interface InformedInput { taskId: string; downgradeSeq: number; round: number; head: string }

/** Record that PM was told about one failed follow-up. beforeWrite (the lease check) runs inside the transaction, first. */
export function recordFollowUpInformed(db: Database, ctx: WriteCtx, input: InformedInput, beforeWrite: () => void = () => {}):
  { ok: true; duplicate: boolean; event: LedgerEvent } {
  return tx(db, () => {
    beforeWrite();
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "后续节点失败通知只由调度服务记账");
    const task = getTask(db, input.taskId);
    if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
    const row = db.prepare("SELECT * FROM events WHERE seq = ?").get(input.downgradeSeq) as Record<string, unknown> | null;
    const e = row ? toEvent(row) : null;
    if (!e || !isFailedFollowUp(task, e)) throw new LedgerError("conflict", `事件 ${input.downgradeSeq} 不是 ${task.id} 后续节点未建成的降级记录`);
    if (e.data.round !== input.round || e.data.head !== input.head) throw new LedgerError("conflict", "降级记录的轮次 / head 与通知时看到的不一致");
    const key = convergeNoticeKey(task.id, e.seq), prior = getEventByDedup(db, key);
    if (prior) {
      if (prior.target !== task.id || prior.data.downgradeSeq !== e.seq) throw new LedgerError("dedup_mismatch", "通知幂等键已被别的记录占用");
      return { ok: true as const, duplicate: true, event: prior };
    }
    const event = insertEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: key }, {
      project: task.project, target: task.id, kind: "scheduler", text: followUpFailureText(task.id, e),
      data: { op: "review_followup_failed", downgradeSeq: e.seq, informed: true },
    }, true);
    return { ok: true as const, duplicate: false, event };
  });
}
