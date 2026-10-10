/** Remote conclusions enter the same scheduler arbitration event only through a current bound lend lease. */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import { getLendOrder, refuse, type LendOrder } from "./ledger-lend.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import type { ResultRequest, LendReceipt } from "./lend-wire.js";
import type { LendResultDeps } from "./ledger-lend-result.js";
import { sanitizeForeign } from "./order-wire-render.js";
import { closeSettledOrderAsks } from "./order-ask-terminal.js";
export { deliveryBranchMatches, assertConvergenceDeliveryLease } from "./fix-strategy-remote-branch.js";
export { completeConvergenceDelivery } from "./fix-strategy-remote-deliver.js";

function receipt(db: Database, o: LendOrder, sha: string, seq: number, deps: LendResultDeps, now: number, terminal: boolean): LendReceipt {
  const signature = deps.sign([o.orderId, sha, String(seq), o.taskId]);
  if (!signature) return refuse("invalid", "无法签出借回执");
  const value = { orderId: o.orderId, sha256: sha, eventSeq: seq, taskId: o.taskId, ...signature };
  if (terminal) {
    db.query("UPDATE lend_orders SET status = 'done', resultSha = ?, receipt = ?, eventSeq = ?, updatedAt = ? WHERE orderId = ?")
      .run(sha, JSON.stringify(value), seq, now, o.orderId);
    closeSettledOrderAsks(db, o.orderId, now); // 正式 done 才收尾；取消确认（terminal=false）不碰提问
  }
  return value;
}

function cancellationResult(db: Database, ctx: WriteCtx, o: LendOrder, req: ResultRequest, sha: string, deps: LendResultDeps): LendReceipt {
  const cancel = listEvents(db, { project: o.project, target: o.taskId }).find((e) => e.data.op === "convergence_cancel" &&
    e.data.orderId === o.orderId && e.data.gen === req.gen);
  const proto = (db.query("SELECT proto FROM lend_peers WHERE peer = ?").get(o.peer) as { proto: number } | null)?.proto ?? 1;
  if (!cancel || proto < 3 || o.status !== "cancelled" || !cancel.data.needsAck || req.verdict.head !== o.head || req.session.family !== o.family ||
    (req.cancelAck?.workerAbsent ? !req.cancelAck.clean || req.session.id !== "" : !req.session.id)) {
    return refuse("cancelled", "取消确认不属于受限收回的绑定单");
  }
  const key = `convergence-cancel:${o.orderId}`, prior = getEventByDedup(db, key);
  if (prior && prior.data.sha !== sha) return refuse("conflict", "取消确认已有不同结论");
  const event = prior ?? insertEvent(db, { actor: "scheduler", now: ctx.now, dedupKey: key }, { project: o.project, target: o.taskId,
    kind: "scheduler", text: "出借方确认旧写 worker 已停止", data: { op: "convergence_cancel_ack", orderId: o.orderId,
      intentId: cancel.data.intentId, gen: req.gen, clean: req.cancelAck!.clean, session: req.session.id || null, workerAbsent: req.cancelAck!.workerAbsent === true, sha } }, true);
  return receipt(db, o, sha, event.seq, deps, ctx.now ?? Date.now(), false);
}

export function convergenceResult(db: Database, ctx: WriteCtx, peer: string, req: ResultRequest, sha: string,
  deps: LendResultDeps): LendReceipt | null {
  const order = getLendOrder(db, req.orderId);
  if (!req.arbitration && !req.cancelAck && order?.wire.convergence?.kind !== "arbitration") return null;
  return tx(db, () => {
    const o = getLendOrder(db, req.orderId), now = ctx.now ?? Date.now();
    if (!o || o.peer !== peer || !o.worker || req.gen !== o.leaseGen) return refuse("not_found", "没有绑定的收敛单/租约代数");
    if (req.cancelAck) return cancellationResult(db, ctx, o, req, sha, deps);
    const binding = o.wire.convergence;
    if (binding?.kind !== "arbitration" || !req.arbitration) return refuse("invalid", "只收绑定仲裁单的专用结论");
    const intent = getIntent(db, binding.intentId), task = mustTask(db, o.taskId);
    if (!intent || intent.action !== "arbitrate" || !["submitted", "done"].includes(intent.status) || intent.taskId !== task.id ||
      intent.head !== o.head || intent.specRev !== o.specRev || task.stage !== "review" || task.specRev !== o.specRev ||
      task.headSHA !== o.head || task.round !== o.round || task.rev !== intent.taskRev || req.arbitration.specRev !== task.specRev ||
      req.arbitration.round !== task.round || req.arbitration.head !== o.head || req.verdict.head !== o.head) {
      return refuse("invalid", "仲裁单/head/specRev/轮次已过期或伪造");
    }
    if (o.status === "cancelled" || o.status === "unknown" || (o.leaseUntil ?? 0) < now) return refuse("cancelled", "仲裁单已取消或过期");
    if (o.resultSha) return o.resultSha === sha && o.receipt ? o.receipt : refuse("conflict", "仲裁已有不同结论");
    if (o.status !== "claimed" || intent.status !== "submitted") return refuse("cancelled", "仲裁单未在跑");
    const wrote = remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)!.authorFamily;
    const author = getSchedulerSession(db, task.id, "author"), reviewer = getSchedulerSession(db, task.id, "reviewer");
    if (o.family === wrote || req.session.family !== o.family || !req.report.trim() ||
      [...binding.excludedSessions, author?.sessionId, reviewer?.sessionId].includes(req.session.id)) {
      return refuse("invalid", "仲裁家族/session/报告不合格");
    }
    const dispute = listEvents(db, { project: task.project, target: task.id }).find((e) => e.seq === binding.disputeSeq);
    if (dispute?.data.op !== "finding_dispute" || dispute.data.specRev !== task.specRev || dispute.data.findingId !== binding.findingId) {
      return refuse("invalid", "仲裁争议绑定不符");
    }
    const path = join(deps.reportDir(o), `arbitration-${o.orderId.replaceAll(":", "_")}.md`);
    const event = insertEvent(db, { actor: "scheduler", now, dedupKey: `scheduler:${intent.id}:verdict` }, { project: task.project, target: task.id,
      kind: "scheduler", text: `仲裁 ${binding.findingId}：${req.arbitration.verdict}`, data: { op: "arbitration_result", intentId: intent.id,
        specRev: task.specRev, round: task.round, disputeSeq: dispute.seq, findingId: dispute.data.findingId, family: dispute.data.family,
        verdict: req.arbitration.verdict, report: path, reviewer: `${o.worker}@${peer}`, reviewerSessionId: req.session.id, reviewerFamily: o.family } }, true);
    const value = receipt(db, o, sha, event.seq, deps, now, true);
    deps.writeReport(path, sanitizeForeign(req.report).split("\n").map((line) => `> ${line}`).join("\n"));
    return value;
  });
}
