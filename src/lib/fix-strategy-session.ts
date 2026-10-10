/** Author epochs use the session writer's transaction and retain the retired row and both lifecycle receipts. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { LedgerError, getEventByDedup } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { requireSessionIdentity } from "./scheduler-session-identity.js";
import type { SchedulerSession } from "./scheduler-sessions.js";
import type { SessionRef } from "./worker-session.js";
import type { LedgerTask } from "./ledger-stages.js";
import { updateTask } from "./fix-strategy-task-write.js";

/**
 * The current round's fix step is an explicit row owned by the new writer: a missing row is created (else stepAtStage falls back
 * to an older fix/write row and take_order hands the old writer this fix), an existing one is reassigned. Rows of earlier rounds
 * stay as history; the step event keeps who was replaced. Same transaction as the binding, so both commit or roll back.
 */
function assignFixStep(db: Database, ctx: WriteCtx, task: LedgerTask, ref: SessionRef, intentId: string, replaces: string | null, now: number): void {
  db.query(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, createdAt, updatedAt) VALUES (?, 'fix', ?, ?, 'agent', 'assigned', ?, ?)
    ON CONFLICT (taskId, step, round) DO UPDATE SET executor = excluded.executor, executorKind = 'agent', state = 'assigned', rev = rev + 1, updatedAt = excluded.updatedAt`)
    .run(task.id, task.round, ref.agent, now, now);
  insertEvent(db, ctx, { project: task.project, target: task.id, kind: "step", data: { op: "assign", step: "fix", round: task.round,
    executor: ref.agent, executorKind: "agent", sessionId: ref.sessionId, replaces, intentId } }, false);
}

export function applyFixReplacement(db: Database, ctx: WriteCtx, intentId: string, ref: SessionRef, material: string,
  migrate: () => void, registryPath?: string): void {
  tx(db, () => {
    const intent = getIntent(db, intentId);
    if (ctx.actor !== "scheduler" || !intent || intent.action !== "fix_swap" || intent.status !== "submitted") {
      throw new LedgerError("forbidden", "缺已认领的修复换会话意图");
    }
    const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id);
    if (getEventByDedup(db, `scheduler:${intentId}:replacement`)) return;
    if (task.stage !== "fix" || task.specRev !== intent.specRev || task.rev !== intent.taskRev || task.headSHA !== intent.head || workflow?.mode !== "auto") {
      throw new LedgerError("conflict", "换修复会话时卡已变化");
    }
    requireSessionIdentity(db, task, { ...ref, intentId, registryPath }, ref.agent);
    const old = db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND role = 'author' AND state != 'retired'")
      .get(task.id) as SchedulerSession | null;
    const archived = getEventByDedup(db, `scheduler:${intentId}:archive`), killed = getEventByDedup(db, `scheduler:${intentId}:kill`);
    if (old && (!archived || !killed || old.sessionId === ref.sessionId || old.transport === "peer")) {
      throw new LedgerError("conflict", "新会话绑定前必须先归档并确认旧会话停止");
    }
    migrate();
    const now = ctx.now ?? Date.now();
    if (old) db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, archiveReceipt = ?, killReceipt = ?, updatedAt = ? WHERE sessionId = ?")
      .run(intentId, String(archived!.data.receipt), String(killed!.data.receipt), now, old.sessionId);
    db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, 'author', ?, ?, ?, ?, 'active', ?, ?, ?)`).run(task.id, ref.agent, ref.sessionId, ref.family, ref.transport, intentId, now, now);
    updateTask(db, ctx, task, { agent: ref.agent, assigneeKind: "agent", assignee: ref.agent });
    db.query("UPDATE task_workflows SET authorFamily = ?, rev = rev + 1, updatedAt = ? WHERE taskId = ?").run(ref.family, now, task.id);
    assignFixStep(db, ctx, task, ref, intentId, old?.agent ?? null, now);
    insertEvent(db, { ...ctx, dedupKey: `scheduler:${intentId}:replacement` }, { project: task.project, target: task.id, kind: "scheduler",
      text: "修复新会话已绑定；先红后绿，交付写测试名", data: { op: "fix_strategy", intentId, round: task.round, specRev: task.specRev,
        head: task.headSHA, family: ref.family, agent: ref.agent, sessionId: ref.sessionId, material,
        mode: getEventByDedup(db, `scheduler:${intentId}:materials`)?.data.mode, findings: getEventByDedup(db, `scheduler:${intentId}:materials`)?.data.findings } }, true);
  });
}
