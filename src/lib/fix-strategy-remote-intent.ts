/** The common intent gate has no dependency on either local or remote execution. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { LedgerError } from "./ledger-store.js";

export function convergenceIntent(db: Database, ctx: WriteCtx, id: string, action: SchedulerIntent["action"]): SchedulerIntent {
  const intent = getIntent(db, id);
  if (ctx.actor !== "scheduler" || !intent || intent.action !== action) throw new LedgerError("forbidden", "缺调度服务的收敛意图");
  const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id);
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || task.specRev !== intent.specRev || task.headSHA !== intent.head) {
    throw new LedgerError("conflict", "收敛意图的规格或 head 已过期");
  }
  if (!["pending", "submitted", "done"].includes(intent.status)) throw new LedgerError("conflict", "收敛意图状态不允许执行");
  return intent;
}

