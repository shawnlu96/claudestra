/**
 * The one mode change the scheduler identity may make: give a card back to PM (peer delegation, Pi, unknown runtime,
 * missing session). It never re-enables automation; pending intents are cancelled (an unclaimed pool order is withdrawn with
 * its intent), anything in flight stays for PM.
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { closePoolOrders } from "./ledger-scheduler-pool.js";
import { getEventByDedup, getMeta, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";

export function fallbackToManual(db: Database, ctx: WriteCtx, input: { taskId: string; reason: string; intentId?: string }): { workflow: TaskWorkflow; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const meta = getMeta(db, task.project);
    if (ctx.actor !== "scheduler" && (ctx.actor === meta.team?.dispatcher || !isManager(db, ctx.actor, { project: task.project, agent: null }))) {
      throw new LedgerError("forbidden", "只有调度服务或项目 PM / master / owner 能把任务退回人工");
    }
    const reason = input.reason.replace(/\s+/g, " ").trim();
    if (!reason || reason.length > 600) throw new LedgerError("invalid", "退回原因要是 1–600 字");
    const workflow = getWorkflow(db, task.id);
    if (!workflow) throw new LedgerError("not_found", "任务没有调度流程");
    const dedupKey = `scheduler:fallback:${task.id}:w${workflow.rev}:${input.intentId ?? "-"}`;
    if (workflow.mode === "manual") {
      if (getEventByDedup(db, `scheduler:fallback:${task.id}:w${workflow.rev - 1}:${input.intentId ?? "-"}`)) return { workflow, duplicate: true };
      throw new LedgerError("conflict", "任务已是 manual");
    }
    const now = ctx.now ?? Date.now();
    const pool = closePoolOrders(db, { ...ctx, now }, task.id, `退回人工：${reason}`);
    const pending = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status = 'pending'").all(task.id) as { id: string }[];
    db.query("UPDATE scheduler_intents SET status = 'cancelled', updatedAt = ? WHERE taskId = ? AND status = 'pending'").run(now, task.id);
    for (const row of pending) db.query("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(row.id);
    db.query("UPDATE task_workflows SET mode = 'manual', rev = rev + 1, updatedAt = ? WHERE taskId = ?").run(now, task.id);
    insertEvent(db, { actor: ctx.actor, now, dedupKey }, {
      project: task.project, target: task.id, kind: "scheduler", text: `退回人工：${reason}`,
      data: { op: "fallback_manual", from: workflow.mode, reason, intentId: input.intentId ?? null, workflowRev: workflow.rev + 1,
        cancelledIntents: pending.map((p) => p.id),
        ...(pool.withdrawn.length || pool.stray.length ? { poolOrders: pool } : {}), ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    return { workflow: getWorkflow(db, task.id) as TaskWorkflow, duplicate: false };
  });
}
