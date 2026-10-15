/** Scheduler reclaim is a capability of one current cross-family fix intent, never a substitute for PM identity. */
import type { Database } from "bun:sqlite";
import { mustTask, resolveAssignee, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { convergenceIntent } from "./fix-strategy-remote-intent.js";
import { getEventByDedup, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { convergeReview } from "./review-converge.js";
import { fixStrategy } from "./fix-strategy.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { endWriteLease, getWriteLease, heldLease, type WriteLease } from "./ledger-lend-lease.js";
import { listLendOrders } from "./ledger-lend.js";
import { isWriteStep } from "./lend-git.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { RemoteConvergenceContext } from "./fix-strategy-remote-context.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { updateTask } from "./fix-strategy-task-write.js";
import { leaseRestore } from "./lend-send-back-restore.js";
import { recordStoppedExits, stoppedReportSeq } from "./lend-reclaim-stopped.js";
import { closeSettledOrderAsks } from "./order-ask-terminal.js";
import { localSwapAuthority, localSwapEvidenceOf, localSwapTrigger } from "./recovery-fix-local-swap-run.js";
import type { LedgerEvent } from "./ledger-stages.js";
import type { SwapGate } from "./fix-strategy-guard.js";
import { selfHealMode, selfHealSample } from "./fix-swap-halfbuilt-sample.js";

function reclaimAuthority(db: Database, ctx: WriteCtx, id: string) {
  const intent = convergenceIntent(db, ctx, id, "fix_swap"), task = mustTask(db, intent.taskId);
  if (task.stage !== "fix" || task.rev !== intent.taskRev || !["pending", "submitted"].includes(intent.status)) {
    throw new LedgerError("conflict", "reclaim requires the current fix round");
  }
  // GATESWAP1: a fixLocalSwap intent's authority is its frozen trigger evidence re-read now, never a four-round streak.
  const swap = localSwapEvidenceOf(db, id);
  if (swap) {
    const why = localSwapAuthority(db, task, swap);
    if (why) throw new LedgerError("forbidden", `fixLocalSwap 收回授权不成立：${why}`);
    return { task, intent, strategy: { family: swap.family } };
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

function leaseWriters(db: Database, taskId: string, lease: WriteLease) {
  return listLendOrders(db, taskId).filter((o) => isWriteStep(o.step) && o.peer === lease.peer &&
    o.branch === lease.branch && o.repo === lease.repo && ["pooled", "claimed", "unknown", "cancelled"].includes(o.status));
}

function cleanExit(db: Database, orderId: string, gen: number): boolean {
  const ack = getEventByDedup(db, `convergence-cancel:${orderId}`);
  return (ack?.data.clean === true && ack.data.gen === gen) || stoppedReportSeq(db, orderId, gen) !== null;
}

export async function reclaimForFamilySwap(db: Database, ctx: WriteCtx, id: string, context: RemoteConvergenceContext,
  active: () => void, edge?: () => Promise<string | (() => string | null)>): Promise<string | null> {
  active();
  const { task } = reclaimAuthority(db, ctx, id), swap = localSwapEvidenceOf(db, id);
  if (getEventByDedup(db, `scheduler:${id}:reclaim`)) return null;
  // GATESWAP1: a fixLocalSwap reclaim re-reads its live trigger before each effect, inside the same transaction, after every await.
  const lapse = swap ? await localSwapTrigger(db, task, swap, context, () => ctx.now ?? Date.now()) : () => null;
  active();
  const gone = lapse();
  if (gone) return gone;
  const lease = heldLease(db, task);
  if (!lease) return resumeAfterReclaim(db, ctx, id, context, active, lapse);
  const running = leaseWriters(db, task.id, lease).filter((o) => o.status !== "cancelled" ||
    (o.leaseGen > 0 && !cleanExit(db, o.orderId, o.leaseGen) && !getEventByDedup(db, `scheduler:${id}:cancel:${o.orderId}`)));
  const revoked = running.length && tx(db, () => {
      let waiting = false;
      reclaimAuthority(db, ctx, id);
      const lapsed = lapse();
      if (lapsed) return lapsed;
      for (const o of running) {
        const needsAck = (o.leaseGen > 0 || o.status !== "pooled") && !cleanExit(db, o.orderId, o.leaseGen);
        waiting ||= needsAck || o.status === "pooled";
        if (o.status !== "cancelled") {
          db.query("UPDATE lend_orders SET status = 'cancelled', reason = ?, updatedAt = ? WHERE orderId = ? AND status = ?")
            .run(`CONV3 family swap ${id}`, ctx.now ?? Date.now(), o.orderId, o.status);
          closeSettledOrderAsks(db, o.orderId, ctx.now ?? Date.now());
        }
        db.query("DELETE FROM task_steps WHERE taskId = ? AND step = ? AND round = ? AND executorKind = 'peer' AND executor = ? AND state = 'assigned'")
          .run(task.id, o.step, o.round, `${o.worker}@${o.peer}`);
        insertEvent(db, { ...ctx, dedupKey: `scheduler:${id}:cancel:${o.orderId}` }, { project: task.project, target: task.id,
          kind: "scheduler", text: needsAck ? "换家族前撤旧写单，等待干净停止确认" : "换家族前撤旧写单；出借方撤单前已报停，按干净退出", data: { op: "convergence_cancel", intentId: id, orderId: o.orderId,
            gen: o.leaseGen, needsAck, head: o.head } }, true);
      }
      return waiting;
    });
  if (typeof revoked === "string") return revoked;
  if (revoked) return "旧写单已取消；等待干净停止确认，不主动停止远端会话";
  const cancelled = listEvents(db, { project: task.project, target: task.id }).filter((e) => e.data.op === "convergence_cancel" && e.data.intentId === id);
  if (cancelled.some((e) => e.data.needsAck && !cleanExit(db, String(e.data.orderId), Number(e.data.gen))) ||
    leaseWriters(db, task.id, lease).some((o) => o.leaseGen > 0 && !cleanExit(db, o.orderId, o.leaseGen))) {
    const old = (getLendPeer(db, lease.peer)?.proto ?? 1) < 3;
    const reason = old ? `${lease.peer} proto<3，不能回写干净取消确认；等待PM决定手动lend-reclaim` : "等待绑定旧单的干净停止确认，写租约尚未收回";
    if (old) await notifyOldHolder(db, ctx, id, reason, context, active);
    return reason;
  }
  const head = await context.remoteHead(lease.repo, lease.branch); active();
  if (!head.ok || head.head !== task.headSHA) return "远端写分支已变化或无法核实，不收回写租约";
  // GATESWAP1: the caller's last awaited proof (a fixLocalSwap's quota), or its refusal; what it hands back is the synchronous proof
  // (the author tree) the transaction re-reads at the commit point, so the transaction below awaits nothing and no earlier sample decides.
  const proof = edge ? await edge() : null; active();
  if (typeof proof === "string") return proof;
  return tx(db, () => {
    const current = reclaimAuthority(db, ctx, id), held = heldLease(db, current.task);
    if (!held || held.peer !== lease.peer || held.branch !== lease.branch) throw new LedgerError("conflict", "lease changed while checking remote head");
    const lapsed = lapse() ?? proof?.() ?? null;
    if (lapsed) return lapsed;
    const live = leaseWriters(db, task.id, held).some((o) => o.status !== "cancelled" || (o.leaseGen > 0 && !cleanExit(db, o.orderId, o.leaseGen)));
    if (live) return "收回前仍有在跑的写单，等待取消";
    const reason = `CONV2 other_family ${current.strategy.family}; intent ${id}${swap ? `; fixLocalSwap ${swap.source}` : ""}`;
    recordStoppedExits(db, ctx, task, id, leaseWriters(db, task.id, held), insertEvent);
    endWriteLease(db, task.id, reason, ctx.now ?? Date.now());
    // Same restore as sendBack (lend-send-back-restore.ts): the assignee before lending, and the pin on the reclaimed peer, which no
    // longer holds the write lease and so can never be sent the fix. resolveAssignee widens the patch to all three assignee columns.
    const back = leaseRestore(current.task, held, held.peer);
    if (back) {
      const rev = updateTask(db, ctx, current.task, { ...back.patch, ...resolveAssignee(current.task, back.patch) });
      db.query("UPDATE scheduler_intents SET taskRev = ?, updatedAt = ? WHERE id = ? AND taskRev = ?")
        .run(rev, ctx.now ?? Date.now(), id, current.task.rev);
    }
    db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE taskId = ? AND role = 'author' AND transport = 'peer'")
      .run(id, ctx.now ?? Date.now(), task.id);
    insertEvent(db, { ...ctx, dedupKey: `scheduler:${id}:reclaim` }, { project: task.project, target: task.id,
      kind: "scheduler", text: reason, data: { op: "fix_strategy_reclaim", intentId: id, round: task.round, specRev: task.specRev,
        head: task.headSHA, reason, peer: lease.peer, unpinned: back?.unpinned ?? null, family: current.strategy.family, taskRev: mustTask(db, task.id).rev,
        ...(swap ? { source: swap.source } : {}) } }, true);
    return null;
  });
}

const NO_LEASE = "remote author has no held write lease";

/**
 * SWAPFIX1 9b: the facts a retry (a new intent of the same swap) may resume on when the lease is already gone. All must hold: the
 * lease row is ended and is the projection of a formal earlier `fix_strategy_reclaim` (its own dedup key, same card / spec / round /
 * head, same peer and reason); that earlier intent is cancelled and bound no replacement author; no write order is pooled, claimed or
 * unknown. Read again inside the commit transaction; the string is the refusal.
 */
function priorReclaim(db: Database, ctx: WriteCtx, id: string): { reclaim: LedgerEvent; lease: WriteLease } | string {
  const { task } = reclaimAuthority(db, ctx, id);
  if (getWorkflow(db, task.id)?.mode !== "auto") return "卡不在 auto，不自愈";
  if (heldLease(db, task)) return "写租约又被持有";
  const lease = getWriteLease(db, task.id);
  if (!lease || lease.state !== "ended") return "没有已结束的写租约";
  const reclaim = listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "scheduler" &&
    e.data.op === "fix_strategy_reclaim" && e.data.round === task.round && e.data.specRev === task.specRev && e.data.head === task.headSHA);
  const prev = typeof reclaim?.data.intentId === "string" ? reclaim.data.intentId : null;
  if (!reclaim || !prev || prev === id || getEventByDedup(db, `scheduler:${prev}:reclaim`)?.seq !== reclaim.seq) return "没有同卡同规格同轮同 head 的正式前次收回";
  if (lease.peer !== reclaim.data.peer || lease.reason !== reclaim.data.reason) return "已结束的写租约不是前次收回结束的那一份";
  const before = getIntent(db, prev);
  if (!before || before.action !== "fix_swap" || before.taskId !== task.id || before.status !== "cancelled") return "前次收回的意图没有正规结清（不是 cancelled）";
  if (getEventByDedup(db, `scheduler:${prev}:replacement`) ||
    db.query("SELECT 1 FROM scheduler_sessions WHERE taskId = ? AND createIntentId = ?").get(task.id, prev)) return "前次意图已绑过替换作者";
  if (listLendOrders(db, task.id).some((o) => isWriteStep(o.step) && ["pooled", "claimed", "unknown"].includes(o.status))) return "仍有挂着 / 在跑 / 待核的写单";
  return { reclaim, lease };
}

/**
 * No held lease: under lendReclaimIntent=on a proven earlier reclaim of this round is resumed — never a second reclaim, never a
 * reclaim event of this intent — after the remote branch is read back at the card head, re-proving every fact and the switch itself
 * in the transaction that retires the stale peer author (retireReclaimedPeerAuthor). off / observe / any failed fact refuse as before.
 * The awaits that follow (tree, codex slot, create) are covered by resumedReclaimGate at the create and bind edges.
 */
async function resumeAfterReclaim(db: Database, ctx: WriteCtx, id: string, context: RemoteConvergenceContext, active: () => void,
  lapse: () => string | null): Promise<null> {
  const task = mustTask(db, convergenceIntent(db, ctx, id, "fix_swap").taskId), mode = selfHealMode(db, task.project, "lendReclaimIntent");
  if (mode === "off") throw new LedgerError("conflict", NO_LEASE);
  const refuse = (why: string, as = mode) => new LedgerError("conflict", as === "on" ? `${NO_LEASE}（不续用前次收回：${why}）` : NO_LEASE);
  const first = priorReclaim(db, ctx, id);
  if (typeof first === "string") throw refuse(first);
  const head = await context.remoteHead(first.lease.repo, first.lease.branch); active();
  if (!head.ok || head.head !== task.headSHA) throw refuse("远端分支 head 已不是卡 head 或无法核实");
  const sample = { project: task.project, key: "lendReclaimIntent" as const, taskId: task.id, head: task.headSHA!, action: "reclaim-resume" as const,
    text: `续用前次收回（事件 #${first.reclaim.seq}，意图 ${String(first.reclaim.data.intentId)}），退役旧 peer 作者后由 ${id} 在本机建作者`,
    data: { intentId: id, reclaimSeq: first.reclaim.seq, prevIntentId: first.reclaim.data.intentId, peer: first.lease.peer } };
  const observed = tx(db, () => {
    // the switch is part of the permission: read again after the await, never the value taken before it
    const now = selfHealMode(db, task.project, "lendReclaimIntent");
    if (now === "off") throw new LedgerError("conflict", NO_LEASE);
    const again = priorReclaim(db, ctx, id), lapsed = lapse();
    if (typeof again === "string" || lapsed) throw refuse(typeof again === "string" ? again : lapsed!, now);
    if (again.reclaim.seq !== first.reclaim.seq || again.lease.repo !== first.lease.repo || again.lease.branch !== first.lease.branch ||
      mustTask(db, task.id).headSHA !== head.head) throw refuse("前次收回或卡 head 在核实远端时已变", now);
    if (now === "observe") { selfHealSample(db, "observe", sample, ctx.now ?? Date.now()); return true; } // recorded, then refused outside
    retireReclaimedPeerAuthor(db, ctx, id, task.id);
    selfHealSample(db, "on", sample, ctx.now ?? Date.now());
    return false;
  });
  if (observed) throw new LedgerError("conflict", NO_LEASE);
  return null;
}

/**
 * The create / bind edge of a resumed reclaim: this intent wrote no reclaim of its own,
 * so the local author it builds stands on the earlier reclaim alone, and every fact of it — the switch at on, the auto card, the ended
 * lease that reclaim ended, the earlier intent settled with no replacement, no pooled / claimed / unknown write order — is read again
 * synchronously right before the create and before the bind. undefined = the intent reclaimed for itself (nothing to resume).
 */
export function resumedReclaimGate(db: Database, ctx: WriteCtx, id: string): SwapGate | undefined {
  if (getEventByDedup(db, `scheduler:${id}:reclaim`)) return undefined;
  const pinned = priorReclaim(db, ctx, id);
  const seq = typeof pinned === "string" ? null : pinned.reclaim.seq;
  return () => {
    const task = getTask(db, getIntent(db, id)?.taskId ?? "");
    if (!task || selfHealMode(db, task.project, "lendReclaimIntent") !== "on") return { halted: "drift", reason: "lendReclaimIntent 不在 on，不续用前次收回" };
    let now: ReturnType<typeof priorReclaim>;
    try { now = priorReclaim(db, ctx, id); } catch (e) { return { halted: "drift", reason: (e as Error).message }; }
    if (typeof now === "string") return { halted: now === "卡不在 auto，不自愈" ? "takeover" : "drift", reason: `不续用前次收回：${now}` };
    return now.reclaim.seq === seq ? null : { halted: "drift", reason: "前次收回已不是续用时核过的那一条" };
  };
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

/**
 * The reclaimed peer's author row is stale (its lease ended), yet bindFixReplacement refuses to bind over a live peer row: retire it the
 * way a scheduler reclaim does, re-checking in the same transaction that no lease was taken again meanwhile.
 */
export function retireReclaimedPeerAuthor(db: Database, ctx: WriteCtx, intentId: string, taskId: string): void {
  tx(db, () => {
    if (heldLease(db, mustTask(db, taskId))) throw new LedgerError("conflict", "写租约又被持有，不在本机另建作者");
    db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE taskId = ? AND role = 'author' AND transport = 'peer' AND state != 'retired'")
      .run(intentId, ctx.now ?? Date.now(), taskId);
  });
}
