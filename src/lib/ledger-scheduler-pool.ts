/**
 * `ledger scheduler-pool <intent>` (i28-R9): one BEGIN IMMEDIATE step for a pool intent (a review addressed to `peer:<name>`).
 * First call: re-plan with the same pool facts inside the transaction (local capacity, borrow, remote mode) and only then put
 * the round into the lend pool through T93's order core, linking intent and order with one scheduler event. Later calls
 * mirror the order onto the intent: claimed → submitted, done → done, unknown → unknown (card stops for PM), released /
 * cancelled → cancelled (the round goes local). An order nobody claimed within the timeout is withdrawn by CAS in this
 * transaction; the CAS losing means the peer claimed first, and that claim is then honoured, never cancelled underneath it.
 * tests/scheduler-pool.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getLendOrder, offerLendCore, withdrawPooledLend, type LendOrder } from "./ledger-lend.js";
import { getIntent, getWorkflow, type AuthorFamily, type IntentStatus, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-write.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { BorrowEntry } from "./lend-config.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { planScheduler } from "./scheduler-plan.js";
import { poolLinkKey, poolOrderId, POOL_TIMEOUT_REASON, prCoordinates } from "./scheduler-pool-facts.js";
import { isPoolIntent, POOL_RECIPIENT } from "./scheduler-pool-plan.js";

export interface PoolStepInput {
  intentId: string;
  maxWorkers: number;
  remote: RemotePolicy;
  borrow: readonly BorrowEntry[];
  /** The card's spec text (the peer cannot read this machine's files); null = cannot be offered. */
  spec: string | null;
}
export type PoolOutcome = "pooled" | "claimed" | "done" | "unknown" | "timeout" | "returned" | "refused" | "settled";
export interface PoolStepResult { outcome: PoolOutcome; orderId: string | null; intent: SchedulerIntent; text: string }

const otherFamily = (f: AuthorFamily): AuthorFamily => f === "claude" ? "codex" : "claude";

function settle(db: Database, ctx: WriteCtx, intent: SchedulerIntent, to: IntentStatus, receipt: string): SchedulerIntent {
  let cur = intent;
  // done / unknown are reached from submitted; a pool order can go claimed → answered between two scheduler passes.
  if (cur.status === "pending" && (to === "done" || to === "unknown")) cur = settleIntent(db, ctx, { id: cur.id, from: "pending", to: "submitted", receipt });
  return cur.status === to ? cur : settleIntent(db, ctx, { id: cur.id, from: cur.status, to, receipt });
}

function offer(db: Database, ctx: WriteCtx, intent: SchedulerIntent, input: PoolStepInput): PoolStepResult {
  const refuse = (why: string): PoolStepResult =>
    ({ outcome: "refused", orderId: null, text: why, intent: settleIntent(db, ctx, { id: intent.id, from: "pending", to: "cancelled", receipt: `未投递：${why}` }) });
  if (intent.status !== "pending") throw new LedgerError("conflict", `挂池意图是 ${intent.status}，却没有出借单`);
  const task = mustTask(db, intent.taskId);
  const workflow = getWorkflow(db, task.id);
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review" ||
    task.rev !== intent.taskRev || task.specRev !== intent.specRev || task.headSHA !== intent.head) return refuse("卡在计划之后变了");
  const now = ctx.now ?? Date.now();
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: input.maxWorkers, now, pool: { remote: input.remote, borrow: input.borrow } }, intent.id));
  if (plan.kind !== "intent" || plan.id !== intent.id || plan.recipient !== intent.recipient) return refuse("按当前台账与借入配置重算，已不该挂池");
  const peer = (intent.recipient as string).slice(POOL_RECIPIENT.length);
  const coords = prCoordinates(task.pr);
  if (!input.spec || !coords) return refuse(input.spec ? "卡上没有 GitHub PR 链接" : "找不到规格卡原文");
  const family = otherFamily(workflow.authorFamily);
  let order: LendOrder;
  try {
    order = offerLendCore(db, ctx, { taskId: task.id, peer, family, repo: coords.repo, pr: coords.pr, spec: input.spec,
      borrow: input.borrow.find((b) => b.peer === peer) ?? null });
  } catch (e) {
    if (e instanceof LedgerError) return refuse(`出单被拒：${e.message}`);
    throw e;
  }
  const text = `挂池：${task.id} 第 ${task.round} 轮审查挂给 ${peer} 的 ${family} worker（单号 ${order.orderId}）`;
  insertEvent(db, { actor: ctx.actor, now, dedupKey: poolLinkKey(intent.id) }, {
    project: task.project, target: task.id, kind: "scheduler", text,
    data: { op: "pool_offer", id: intent.id, orderId: order.orderId, peer, family, round: task.round, head: task.headSHA },
  }, true);
  return { outcome: "pooled", orderId: order.orderId, intent, text };
}

function sync(db: Database, ctx: WriteCtx, intent: SchedulerIntent, orderId: string, timeoutMs: number): PoolStepResult {
  let o = getLendOrder(db, orderId);
  if (!o) throw new LedgerError("not_found", `挂池意图的出借单 ${orderId} 不见了`);
  const out = (outcome: PoolOutcome, next: SchedulerIntent, text: string): PoolStepResult => ({ outcome, orderId, intent: next, text });
  const now = ctx.now ?? Date.now();
  if (o.status === "pooled") {
    if (now - o.createdAt < timeoutMs) return out("pooled", intent, `${o.peer} 还没领`);
    const minutes = Math.round(timeoutMs / 60_000);
    const w = withdrawPooledLend(db, ctx, { orderId, reason: `${POOL_TIMEOUT_REASON}：${minutes} 分钟没人领，退回本机` });
    if (w.withdrawn) {
      const text = `挂池 ${minutes} 分钟 ${o.peer} 没人领，已撤回单 ${orderId}，这一轮退回本机审查`;
      return out("timeout", settle(db, ctx, intent, "cancelled", text), text);
    }
    o = w.order;
  }
  const who = `${o.worker ?? "?"}@${o.peer}`;
  if (o.status === "claimed") return out("claimed", intent.status === "pending" ? settle(db, ctx, intent, "submitted", `claimed by ${who} gen ${o.leaseGen}`) : intent, `${who} 在审`);
  if (o.status === "done") return out("done", settle(db, ctx, intent, "done", `lend ${orderId} answered by ${who}; event ${o.eventSeq ?? "?"}`), `${who} 已交结论`);
  if (o.status === "unknown") return out("unknown", settle(db, ctx, intent, "unknown", `出借单 ${orderId} 结果不明（${o.reason ?? ""}），交 PM 核对`), "结果不明，停给 PM");
  const text = `出借单 ${orderId} ${o.status}（${o.reason ?? ""}），这一轮退回本机审查`;
  return out("returned", settle(db, ctx, intent, "cancelled", text), text);
}

export function schedulerPoolStep(db: Database, ctx: WriteCtx, input: PoolStepInput & { timeoutMs: number }): PoolStepResult {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "挂池只由调度服务身份执行");
  return tx(db, () => {
    const intent = getIntent(db, input.intentId);
    if (!intent || !isPoolIntent(intent)) throw new LedgerError("not_found", "没有这个挂池意图");
    const orderId = poolOrderId(db, intent.id);
    if (intent.status !== "pending" && intent.status !== "submitted") return { outcome: "settled", orderId, intent, text: `意图已是 ${intent.status}` };
    return orderId ? sync(db, ctx, intent, orderId, input.timeoutMs) : offer(db, ctx, intent, input);
  });
}
