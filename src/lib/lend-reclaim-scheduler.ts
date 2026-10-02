/** Scheduler reclaim is a capability of one current cross-family fix intent, never a substitute for PM identity. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { convergenceIntent } from "./fix-strategy-remote-intent.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { convergeReview } from "./review-converge.js";
import { fixStrategy } from "./fix-strategy.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { endWriteLease, heldLease } from "./ledger-lend-lease.js";
import { listLendOrders } from "./ledger-lend.js";
import { isWriteStep } from "./lend-git.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { RemoteConvergenceContext } from "./fix-strategy-remote-context.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { updateTask } from "./fix-strategy-task-write.js";

function reclaimAuthority(db: Database, ctx: WriteCtx, id: string) {
  const intent = convergenceIntent(db, ctx, id, "fix_swap"), task = mustTask(db, intent.taskId);
  if (task.stage !== "fix" || task.rev !== intent.taskRev || !["pending", "submitted"].includes(intent.status)) {
    throw new LedgerError("conflict", "reclaim requires the current fix round");
  }
  const events = listEvents(db, { project: task.project, target: task.id }), read = currentReviewFacts(task, events);
  const since = events.findLast((e) => e.data.op === "workflow" && e.data.specRev === task.specRev)?.seq ?? 0;
  const min = events.find((e) => e.kind === "review" && e.seq > since)?.data.round;
  const strategy = read.kind === "facts" ? fixStrategy(events, convergeReview(events, read.facts, null).facts,
    remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)!.authorFamily, typeof min === "number" ? min : 1) : null;
  const material = getEventByDedup(db, `scheduler:${id}:materials`);
  if (strategy?.mode !== "other_family" || material?.data.mode !== "other_family" || material.data.family !== strategy.family) {
    throw new LedgerError("forbidden", "reclaim is restricted to proven CONV2 other_family intent");
  }
  return { task, intent, strategy };
}

export async function reclaimForFamilySwap(db: Database, ctx: WriteCtx, id: string, context: RemoteConvergenceContext,
  active: () => void): Promise<string | null> {
  active();
  const { task } = reclaimAuthority(db, ctx, id);
  if (getEventByDedup(db, `scheduler:${id}:reclaim`)) return null;
  const lease = heldLease(db, task);
  if (!lease) throw new LedgerError("conflict", "remote author has no held write lease");
  const running = listLendOrders(db, task.id).filter((o) => isWriteStep(o.step) && ["pooled", "claimed", "unknown"].includes(o.status));
  if (running.length) {
    tx(db, () => {
      reclaimAuthority(db, ctx, id);
      for (const o of running) {
        db.query("UPDATE lend_orders SET status = 'cancelled', reason = ?, updatedAt = ? WHERE orderId = ? AND status = ?")
          .run(`CONV3 family swap ${id}`, ctx.now ?? Date.now(), o.orderId, o.status);
        db.query("DELETE FROM task_steps WHERE taskId = ? AND step = ? AND round = ? AND executorKind = 'peer' AND executor = ? AND state = 'assigned'")
          .run(task.id, o.step, o.round, `${o.worker}@${o.peer}`);
        insertEvent(db, { ...ctx, dedupKey: `scheduler:${id}:cancel:${o.orderId}` }, { project: task.project, target: task.id,
          kind: "scheduler", text: "换家族前撤旧写单，等待干净停止确认", data: { op: "convergence_cancel", intentId: id, orderId: o.orderId,
            gen: o.leaseGen, needsAck: o.status !== "pooled", head: o.head } }, true);
      }
    });
    return "旧写单已取消；等待干净停止确认，不主动停止远端会话";
  }
  const cancelled = listEvents(db, { project: task.project, target: task.id }).filter((e) => e.data.op === "convergence_cancel" && e.data.intentId === id);
  if (cancelled.some((e) => e.data.needsAck && getEventByDedup(db, `convergence-cancel:${e.data.orderId}`)?.data.clean !== true)) {
    const old = (getLendPeer(db, lease.peer)?.proto ?? 1) < 3;
    const reason = old ? `${lease.peer} proto<3，不能回写干净取消确认；等待PM决定手动lend-reclaim` : "等待绑定旧单的干净停止确认，写租约尚未收回";
    if (old) await notifyOldHolder(db, ctx, id, reason, context, active);
    return reason;
  }
  const head = await context.remoteHead(lease.repo, lease.branch); active();
  if (!head.ok || head.head !== task.headSHA) return "远端写分支已变化或无法核实，不收回写租约";
  return tx(db, () => {
    const current = reclaimAuthority(db, ctx, id), held = heldLease(db, current.task);
    if (!held || held.peer !== lease.peer || held.branch !== lease.branch) throw new LedgerError("conflict", "lease changed while checking remote head");
    const live = listLendOrders(db, task.id).some((o) => isWriteStep(o.step) && ["pooled", "claimed", "unknown"].includes(o.status));
    if (live) return "收回前仍有在跑的写单，等待取消";
    const reason = `CONV2 other_family ${current.strategy.family}; intent ${id}`;
    endWriteLease(db, task.id, reason, ctx.now ?? Date.now());
    if (current.task.assigneeKind === "peer_agent" && current.task.assignee?.startsWith(`${held.fp}/`)) {
      const patch = { agent: held.prevAssigneeKind === "agent" ? held.prevAssignee : null,
        assigneeKind: held.prevAssigneeKind, assignee: held.prevAssignee };
      const rev = updateTask(db, ctx, current.task, patch);
      db.query("UPDATE scheduler_intents SET taskRev = ?, updatedAt = ? WHERE id = ? AND taskRev = ?")
        .run(rev, ctx.now ?? Date.now(), id, current.task.rev);
    }
    db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE taskId = ? AND role = 'author' AND transport = 'peer'")
      .run(id, ctx.now ?? Date.now(), task.id);
    insertEvent(db, { ...ctx, dedupKey: `scheduler:${id}:reclaim` }, { project: task.project, target: task.id,
      kind: "scheduler", text: reason, data: { op: "fix_strategy_reclaim", intentId: id, round: task.round, specRev: task.specRev,
        head: task.headSHA, reason, peer: lease.peer, family: current.strategy.family, taskRev: mustTask(db, task.id).rev } }, true);
    return null;
  });
}

async function notifyOldHolder(db: Database, ctx: WriteCtx, id: string, reason: string, context: RemoteConvergenceContext, active: () => void) {
  const { task } = reclaimAuthority(db, ctx, id), key = `reclaim-old-peer:${task.id}:s${task.specRev}:r${task.round}`;
  if (getEventByDedup(db, key)) return;
  try {
    await context.notify(reason); active();
    tx(db, () => {
      reclaimAuthority(db, ctx, id);
      if (!getEventByDedup(db, key)) insertEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: key }, { project: task.project, target: task.id,
        kind: "scheduler", text: reason, data: { op: "reclaim_wait", intentId: id } }, true);
    });
  } catch (e) { console.warn(`old holder reclaim notice failed; retry next tick: ${(e as Error).message}`); }
}
