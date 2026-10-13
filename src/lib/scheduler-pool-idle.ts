import type { Database } from "bun:sqlite";
import { getIntent } from "./ledger-scheduler.js";
import { getLendOrder } from "./ledger-lend.js";
import { getTask } from "./ledger-store.js";
import { poolOrderId } from "./scheduler-pool-facts.js";

export interface PoolIdleObservation { candidates: number; idle: number; mismatches: number }
export interface PoolIdleCandidate {
  step: "pool_claimed";
  detail: string;
  orderId: string;
  updatedAt: number;
  eventSeq: number;
}

/** Review still needs the CLI's scope registration; missing facts must never suppress that writer. */
export function poolIdleCandidate(db: Database | null, taskId: string, intentId: string): PoolIdleCandidate | null {
  if (!db) return null;
  try {
    const task = getTask(db, taskId), intent = getIntent(db, intentId);
    if (!task || !["spec", "restate", "build", "fix", "merge", "live", "blocked"].includes(task.stage)
      || !intent || intent.taskId !== taskId || intent.project !== task.project || intent.status !== "submitted") return null;
    const orderId = poolOrderId(db, intentId), order = orderId ? getLendOrder(db, orderId) : null;
    if (!order || order.taskId !== taskId || order.project !== task.project || order.status !== "claimed"
      || !["write", "fix", "review"].includes(order.step)) return null;
    return { step: "pool_claimed", detail: `${order.worker ?? "?"}@${order.peer} ${order.step === "review" ? "在审" : "在写"}`,
      orderId: order.orderId, updatedAt: intent.updatedAt, eventSeq: intent.eventSeq };
  } catch (e) {
    // An unreadable snapshot only disables this optimization; the CLI remains responsible for diagnosis and writes.
    console.error(`[pool-idle] 读取失败，回退 CLI：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Check the writer receipt too: a concurrent pending → submitted settle is not an idle synchronization. */
export function observePoolIdle(stats: PoolIdleObservation, candidate: PoolIdleCandidate, res: Record<string, unknown>): void {
  stats.candidates++;
  const intent = res.intent as { status?: unknown; updatedAt?: unknown; eventSeq?: unknown } | undefined;
  const idle = res.ok === true && res.outcome === "claimed" && res.orderId === candidate.orderId && res.text === candidate.detail
    && intent?.status === "submitted" && intent.updatedAt === candidate.updatedAt && intent.eventSeq === candidate.eventSeq;
  if (idle) stats.idle++;
  else stats.mismatches++;
}

export function logPoolIdleObservation(stats: PoolIdleObservation): void {
  if (stats.candidates) console.log(`[pool-idle] 候选数=${stats.candidates} 实际无动作数=${stats.idle} 不一致数=${stats.mismatches}`);
}
