/** One structured, pull-only PM task per dedupKey, closed by an ordinary deduplicated note. */
import type { Database } from "bun:sqlite";
import { actorMaySchedule, textOneLine } from "./ledger-scheduler-settle.js";
import { busyAsLedgerError, getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";

export interface PmTodoNoteInput { project: string; target: string; kind: string; text: string; dedupKey: string }
export function recordPmTodo(db: Database, ctx: WriteCtx, input: PmTodoNoteInput) {
  if (!actorMaySchedule(db, ctx.actor, input.project)) throw new LedgerError("forbidden", "PM 待办写口只给调度或项目配置人");
  const kind = textOneLine(input.kind, "待办类型", 80), text = textOneLine(input.text, "待办正文", 4000);
  const dedupKey = textOneLine(input.dedupKey, "待办去重键", 300);
  if (/^(?:post-verify-done|pm-todo-done):/.test(dedupKey)) throw new LedgerError("invalid", "待办去重键不能占用完成记录的命名空间");
  // Keep the collision check atomic; appendEvent owns event authorization and the local write gate.
  return busyAsLedgerError("写入", () => db.transaction(() => {
    const prior = getEventByDedup(db, dedupKey);
    if (prior && (prior.project !== input.project || prior.target !== input.target || prior.kind !== "note"
      || prior.data.op !== "pm_todo" || prior.data.kind !== kind)) throw new LedgerError("conflict", "待办去重键已被其它记录占用");
    return appendEvent(db, { ...ctx, dedupKey }, { project: input.project, target: input.target, kind: "note", text, data: { op: "pm_todo", kind, dedupKey } });
  }).immediate());
}
