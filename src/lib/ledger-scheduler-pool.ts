import { poolBorrow } from "./scheduler-agent-pool-context.js";
import { projectAgentPolicy } from "./scheduler-agent-pool-context.js";
/**
 * `ledger scheduler-pool <intent>` (i28-R9): one BEGIN IMMEDIATE step for a pool intent (a review, or since i28-W9 a build /
 * fix dispatch, addressed to `peer:<name>`). First call: re-plan with the same pool facts inside the transaction (local
 * capacity, borrow with its tiers, remote policy) and only then put the round into the lend pool through T93's order core
 * (a write order carries the materials the CLI fetched before the transaction), linking intent and order with one
 * scheduler event. Later calls
 * mirror the order onto the intent: claimed → submitted, done → done, unknown → unknown (card stops for PM), released /
 * cancelled → cancelled (the round goes local). An order nobody claimed within the timeout is withdrawn by CAS in this
 * transaction; the CAS losing means the peer claimed first, and that claim is then honoured, never cancelled underneath it.
 * tests/scheduler-pool.test.ts, tests/scheduler-pool-takeover.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { queueTimeoutDue } from "./ledger-lend-queue.js";
import { getLendOrder, offerLendCore, withdrawPooledLend, type LendOrder } from "./ledger-lend.js";
import { getIntent, getWorkflow, type IntentStatus, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { BorrowEntry } from "./lend-config.js";
import type { WriteOffer } from "./ledger-lend-lease.js";
import { stepOfStage } from "./lend-git.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { orderFamily } from "./scheduler-placement-plan.js";
import { planScheduler } from "./scheduler-plan.js";
import { poolLinkKey, poolOrderId, POOL_TIMEOUT_REASON, prCoordinates, strayPoolOrders } from "./scheduler-pool-facts.js";
import { isPoolIntent, POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import { relayOffer } from "./lend-fix-reassign-start.js";
import { isGateRefusal, recordGateRefused } from "./order-gate-heads.js";

export interface PoolStepInput {
  intentId: string;
  maxWorkers: number;
  remote: RemotePolicy;
  borrow: readonly BorrowEntry[];
  /** The card's spec text (the peer cannot read this machine's files); null = cannot be offered. */
  spec: string | null;
  /** A build / fix intent's write materials (lib/lend-write-materials.ts) fetched outside the transaction, or why they could not be. */
  write?: WriteOffer | { error: string } | null;
}
type PoolOutcome = "pooled" | "claimed" | "done" | "unknown" | "timeout" | "withdrawn" | "returned" | "refused" | "settled";
export interface PoolStepResult { outcome: PoolOutcome; orderId: string | null; intent: SchedulerIntent; text: string }

const LABEL = { review: "审查", write: "开工", fix: "修复" } as const;
const backHome = (step: string): string => step === "review" ? "这一轮退回本机审查" : `这一轮${LABEL[step as "write" | "fix"] ?? ""}单退回本机`;

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
  input = { ...input, remote: projectAgentPolicy(task.project) ?? input.remote };
  const workflow = getWorkflow(db, task.id);
  const step = stepOfStage(task.stage);
  const role = step === "review" ? "review" : step;
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || !role || (role === "review") !== (intent.action === "review") ||
    task.rev !== intent.taskRev || task.specRev !== intent.specRev || task.headSHA !== intent.head) return refuse("卡在计划之后变了");
  const now = ctx.now ?? Date.now();
  const snap = autoSnapshot(db, task, { registry: [], maxWorkers: input.maxWorkers, now, pool: { remote: input.remote, borrow: input.borrow } }, intent.id);
  const plan = planScheduler(snap);
  if (plan.kind !== "intent" || plan.id !== intent.id || plan.recipient !== intent.recipient) return refuse("按当前台账与借入配置重算，已不该挂池");
  const peer = (intent.recipient as string).slice(POOL_RECIPIENT.length);
  const coords = prCoordinates(task.pr);
  const repo = coords?.repo ?? (role === "review" ? null : input.remote.repo ?? null);
  if (!input.spec) return refuse("找不到规格卡原文");
  if (!repo) return refuse(role === "review" ? "卡上没有 GitHub PR 链接" : "没有仓库坐标（scheduler.json remote.repo）");
  const write = input.write && !("error" in input.write) ? input.write : null;
  if (role !== "review" && !write) return refuse(`写单材料没备好：${input.write && "error" in input.write ? input.write.error : "对方指纹 / 基线 head / 上一轮审查报告"}`);
  const family = orderFamily(snap, peer, role);
  if (!family) return refuse(`${peer} 已没有能接这一单的家族槽`);
  let order: LendOrder;
  try {
    order = relayOffer(db, ctx, task, peer, write, (relay) => offerLendCore(db, ctx, { taskId: task.id, peer, family, repo, pr: role === "write" || relay ? null : coords?.pr ?? null,
      spec: input.spec!, borrow: poolBorrow(input.borrow.find((b) => b.peer === peer) ?? null, !!input.remote.agents), ...(role !== "review" && write ? { write } : {}) }));
  } catch (e) {
    if (e instanceof LedgerError && isGateRefusal(e.message)) recordGateRefused(db, ctx, task, e.message); // once per card + reason (i28-GATE2)
    if (e instanceof LedgerError) return refuse(`出单被拒：${e.message}`);
    throw e;
  }
  const text = `挂池：${task.id} 第 ${task.round} 轮${LABEL[role]}挂给 ${peer} 的 ${family} worker（单号 ${order.orderId}）`;
  insertEvent(db, { actor: ctx.actor, now, dedupKey: poolLinkKey(intent.id) }, {
    project: task.project, target: task.id, kind: "scheduler", text,
    data: { op: "pool_offer", id: intent.id, orderId: order.orderId, peer, family, round: task.round, head: task.headSHA, step: order.step },
  }, true);
  return { outcome: "pooled", orderId: order.orderId, intent, text };
}

/** `withdraw` = a takeover's reason: an unclaimed order is withdrawn now instead of after the timeout. */
function sync(db: Database, ctx: WriteCtx, intent: SchedulerIntent, orderId: string, timeoutMs: number, withdraw?: string): PoolStepResult {
  let o = getLendOrder(db, orderId);
  if (!o) throw new LedgerError("not_found", `挂池意图的出借单 ${orderId} 不见了`);
  const out = (outcome: PoolOutcome, next: SchedulerIntent, text: string): PoolStepResult => ({ outcome, orderId, intent: next, text });
  const now = ctx.now ?? Date.now();
  if (o.status === "pooled") {
    if (!withdraw && (now - o.createdAt < timeoutMs || !queueTimeoutDue(db, orderId, now - timeoutMs, true))) return out("pooled", intent, `${o.peer} 还没领`);
    const minutes = Math.round(timeoutMs / 60_000);
    const w = withdrawPooledLend(db, ctx, { orderId, reason: withdraw ?? `${POOL_TIMEOUT_REASON}：${minutes} 分钟没人领，退回本机` });
    if (w.withdrawn) {
      const text = withdraw ? `撤回池单 ${orderId}（${o.peer} 还没领）：${withdraw}` : `挂池 ${minutes} 分钟 ${o.peer} 没人领，已撤回单 ${orderId}，${backHome(o.step)}`;
      return out(withdraw ? "withdrawn" : "timeout", settle(db, ctx, intent, "cancelled", text), text);
    }
    o = w.order;
  }
  const who = `${o.worker ?? "?"}@${o.peer}`;
  const review = o.step === "review";
  if (o.status === "claimed") {
    return out("claimed", intent.status === "pending" ? settle(db, ctx, intent, "submitted", `claimed by ${who} gen ${o.leaseGen}`) : intent, `${who} ${review ? "在审" : "在写"}`);
  }
  if (o.status === "done") {
    return out("done", settle(db, ctx, intent, "done", `lend ${orderId} answered by ${who}; event ${o.eventSeq ?? "?"}`), `${who} ${review ? "已交结论" : "已交付"}`);
  }
  if (o.status === "unknown") return out("unknown", settle(db, ctx, intent, "unknown", `出借单 ${orderId} 结果不明（${o.reason ?? ""}），交 PM 核对`), "结果不明，停给 PM");
  const text = `出借单 ${orderId} ${o.status}（${o.reason ?? ""}），${backHome(o.step)}`;
  return out("returned", settle(db, ctx, intent, "cancelled", text), text);
}

/**
 * Every path that cancels a card's pending intents in bulk (takeover, fallback to manual, resume) calls this first, in its
 * own transaction: a pending pool intent's order is an effect already out, so it is settled as a pass would, except an
 * unclaimed order is withdrawn now. A claim that already won leaves the intent submitted / unknown (resume then refuses);
 * a live order whose intent is no longer live is reported as stray, never taken as gone. tests/scheduler-pool-takeover.test.ts.
 */
export function closePoolOrders(db: Database, ctx: WriteCtx, taskId: string, reason: string): { withdrawn: string[]; stray: string[] } {
  const withdrawn: string[] = [];
  const pending = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status = 'pending'").all(taskId) as { id: string }[];
  for (const row of pending) {
    const intent = getIntent(db, row.id);
    const orderId = intent && isPoolIntent(intent) ? poolOrderId(db, intent.id) : null;
    if (intent && orderId && sync(db, ctx, intent, orderId, 0, reason).outcome === "withdrawn") withdrawn.push(orderId);
  }
  for (const o of strayPoolOrders(db, taskId)) {
    if (o.status === "pooled" && withdrawPooledLend(db, ctx, { orderId: o.orderId, reason }).withdrawn) withdrawn.push(o.orderId);
  }
  return { withdrawn, stray: strayPoolOrders(db, taskId).map((o) => o.orderId) };
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
