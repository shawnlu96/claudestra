/**
 * Hand an auto card back to the scheduler after its spec changed (T68h scope 3). A spec change bumps task.specRev; the
 * planner then escalates `workflow_drift` and the card falls back to manual, and `workflow-set` refuses auto once the card
 * is past spec. This is the one way back: the PM (not the scheduler) re-binds the workflow to the current specRev, the
 * planner is re-run on the new facts and its decision is recorded on the event. An intent whose outcome is still open
 * (submitted / unknown) must be reconciled first; plans made for the old spec (pending) are voided.
 * Tests: tests/ledger-scheduler-resume.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { closePoolOrders } from "./ledger-scheduler-pool.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { planScheduler } from "./scheduler-plan.js";

export interface ResumeInput { taskId: string; taskRev: number; workflowRev: number; reason: string; maxWorkers: number }
export interface ResumeResult { workflow: TaskWorkflow; fromSpecRev: number; next: Record<string, unknown> }

export function resumeAutoWorkflow(db: Database, ctx: WriteCtx, input: ResumeInput): ResumeResult {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!actorMayConfigure(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能把任务交回自动");
    if (["done", "cancelled"].includes(task.stage)) throw new LedgerError("invalid", `${task.id} 已${task.stage}，不用交回自动`);
    const workflow = getWorkflow(db, task.id);
    if (!workflow || workflow.mode === "observe") throw new LedgerError("invalid", `${task.id} 不是自动流程的卡（没有流程或是 observe）`);
    if (workflow.mode === "auto" && workflow.specRev === task.specRev) throw new LedgerError("conflict", `${task.id} 已在当前规格（第 ${task.specRev} 版）的自动流程里`);
    if (task.rev !== input.taskRev || workflow.rev !== input.workflowRev) {
      throw new LedgerError("conflict", "任务或流程已被改过，先重读再交回", { taskRev: task.rev, workflowRev: workflow.rev });
    }
    // A pool order still out (pooled → withdrawn now; claimed → its intent stays open) is settled before the open check.
    const pool = closePoolOrders(db, ctx, task.id, `交回自动前撤回：${input.reason.replace(/\s+/g, " ").trim()}`);
    if (pool.stray.length) throw new LedgerError("conflict", `池单 ${pool.stray.join("，")} 已被对方领走或结果不明，却没有在途意图对应，先对账再交回自动`);
    const open = db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ? AND status IN ('submitted','unknown')").all(task.id) as { id: string; status: string }[];
    if (open.length) throw new LedgerError("conflict", `还有结果未定的调度意图（${open.map((o) => `${o.id}:${o.status}`).join("，")}），先对账再交回自动`);
    const reason = textOneLine(input.reason, "交回原因", 600);
    const now = ctx.now ?? Date.now();
    const pending = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status = 'pending'").all(task.id) as { id: string }[];
    db.query("UPDATE scheduler_intents SET status = 'cancelled', updatedAt = ? WHERE taskId = ? AND status = 'pending'").run(now, task.id);
    for (const row of pending) db.query("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(row.id);
    db.query("UPDATE task_workflows SET mode = 'auto', specRev = ?, rev = rev + 1, updatedAt = ? WHERE taskId = ?").run(task.specRev, now, task.id);
    const next = decisionOf(db, task.id, input.maxWorkers, now);
    const fresh = getWorkflow(db, task.id) as TaskWorkflow;
    insertEvent(db, { actor: ctx.actor, now }, {
      project: task.project, target: task.id, kind: "scheduler", text: `交回自动（规格第 ${task.specRev} 版）：${reason}`,
      data: { op: "workflow_resume", from: workflow.mode, fromSpecRev: workflow.specRev, specRev: task.specRev, stage: task.stage,
        workflowRev: fresh.rev, reason, cancelledIntents: pending.map((p) => p.id), next, manual: true },
    }, false);
    return { workflow: fresh, fromSpecRev: workflow.specRev, next };
  });
}

/** What the planner would do next on the new spec; only recorded, the service plans for itself on its next pass. */
function decisionOf(db: Database, taskId: string, maxWorkers: number, now: number): Record<string, unknown> {
  const d = planScheduler(autoSnapshot(db, mustTask(db, taskId), { registry: [], maxWorkers, now }));
  return d.kind === "intent" ? { kind: d.kind, node: d.node, action: d.action } : { kind: d.kind, code: d.code, reason: d.reason };
}
