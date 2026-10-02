/** A remote repair changes the head, so its old-head convergence intent must finish inside the delivery transaction. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import type { LendOrder } from "./ledger-lend.js";
import type { DeliverRequest, LendReceipt } from "./lend-wire.js";
import { getIntent } from "./ledger-scheduler.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { preserveSessionHistory } from "./scheduler-sessions.js";
import { sanitizeForeign } from "./order-wire-render.js";

export function completeConvergenceDelivery(db: Database, ctx: WriteCtx, o: LendOrder, req: DeliverRequest, receipt: LendReceipt): LendReceipt {
  insertEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: `lend-author-session:${o.orderId}` }, { project: o.project, target: o.taskId,
    kind: "note", text: "出借写单的作者会话声明已绑定交付head", data: { op: "lend_author_session", orderId: o.orderId,
      head: req.deliver.head, sessionId: sanitizeForeign(req.session.id), family: o.family, peer: o.peer, worker: o.worker } }, true);
  const binding = o.wire.convergence;
  if (binding?.kind !== "fix") return receipt;
  const intent = getIntent(db, binding.intentId), task = mustTask(db, o.taskId);
  if (!intent || intent.action !== "fix_swap" || intent.status !== "submitted" || intent.taskId !== task.id || intent.head !== o.head ||
    task.stage !== "review" || task.specRev !== o.specRev || task.round !== o.round + 1 || task.headSHA !== req.deliver.head) {
    throw new LedgerError("conflict", "remote repair delivery no longer belongs to its convergence intent");
  }
  const now = ctx.now ?? Date.now();
  preserveSessionHistory(db);
  db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE taskId = ? AND role = 'author' AND state != 'retired'")
    .run(intent.id, now, task.id);
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, 'author', ?, ?, ?, 'peer', 'active', ?, ?, ?)`)
    .run(task.id, `${o.worker}@${o.peer}`, req.session.id, o.family, intent.id, now, now);
  const material = getEventByDedup(db, `scheduler:${intent.id}:materials`)?.data;
  insertEvent(db, { actor: "scheduler", now, dedupKey: `scheduler:${intent.id}:replacement` }, { project: task.project, target: task.id,
    kind: "scheduler", text: "远端新修复会话已交付，收敛意图结束", data: { op: "convergence_effect", intentId: intent.id,
      orderId: o.orderId, family: o.family, sessionId: req.session.id, material: material?.material } }, true);
  settleIntent(db, { actor: "scheduler", now }, { id: intent.id, from: "submitted", to: "done", receipt: "远端新修复会话已交付" });
  return receipt;
}
