/** 领单的异步边界：先找有权领的单，事务外准备记忆，再重核当前单与会话后同步拼单。 */
import type { Database } from "bun:sqlite";
import { readCredStore } from "./caller-cred.js";
import type { CallerIdentity } from "./caller-identity.js";
import { ensureMemoryRetrieval, type EnsureDeps } from "./memory-retrieve-order.js";
import { currentOrders, takeOrderResult } from "./order-take.js";
import type { VerifiedCall } from "./order-tool-route.js";
import { readRegistryAgentsSync } from "./registry.js";
import { reviewCallerOf, reviewSlotsFor, takeReview, type TakeReviewResult } from "./review-order.js";
import { getSchedulerSession, type SessionRole } from "./scheduler-sessions.js";

/** 原始身份已由 bridge 验证；记下当前注册身份和凭据世代，等待中重启 / 换会话就拒绝旧领取。 */
function callerStamp(agent: string): string {
  const a = readRegistryAgentsSync().find((r) => r.name === agent);
  const creds = Object.entries(readCredStore()).filter(([, c]) => c.agent === agent).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([a?.channelId, a?.sessionId, a?.runtime, creds]);
}

function claimStamp(db: Database, slots: readonly { task: { id: string } }[], role: SessionRole): string {
  return JSON.stringify([slots, slots.map((s) => getSchedulerSession(db, s.task.id, role))]);
}

function claimValid(db: Database, slots: readonly { task: { id: string } }[], role: SessionRole,
  who: { agent: string; sessionId: string | null }): boolean {
  const registered = readRegistryAgentsSync().find((r) => r.name === who.agent);
  if (registered?.sessionId && registered.sessionId !== who.sessionId) return false;
  return slots.every((s) => {
    const bound = getSchedulerSession(db, s.task.id, role);
    return !bound || (bound.state === "active" && bound.agent === who.agent && bound.sessionId === who.sessionId);
  });
}

export async function takeOrderWithMemory(db: Database | null, call: VerifiedCall, deps: EnsureDeps = {}): Promise<ReturnType<typeof takeOrderResult>> {
  if (!db) return takeOrderResult(db, call);
  const orders = currentOrders(db, call);
  if (!orders.length) return takeOrderResult(db, call);
  if (!claimValid(db, orders, "author", call)) return { ok: false, error: "当前会话没有有效领单绑定" };
  const before = claimStamp(db, orders, "author"), caller = callerStamp(call.agent);
  const first = orders[0]!;
  await ensureMemoryRetrieval(db, first.task, "write", first.task.headSHA, deps);
  if (before !== claimStamp(db, currentOrders(db, call), "author") || caller !== callerStamp(call.agent)) {
    return { ok: false, error: "记忆检索期间订单或会话已变化，请重新领单" };
  }
  return takeOrderResult(db, call, true);
}

export async function takeReviewWithMemory(db: Database, identity: CallerIdentity, dir?: string, deps: EnsureDeps = {}): Promise<TakeReviewResult> {
  const who = reviewCallerOf(identity);
  if ("error" in who) return { ok: false, ...who };
  const slots = reviewSlotsFor(db, who.caller);
  if (!claimValid(db, slots, "reviewer", who.caller)) return { ok: false, error: "no_order", message: "当前会话没有有效领单绑定" };
  const before = claimStamp(db, slots, "reviewer"), caller = callerStamp(who.caller.agent);
  for (const slot of slots) {
    if (before !== claimStamp(db, reviewSlotsFor(db, who.caller), "reviewer") || caller !== callerStamp(who.caller.agent)) break;
    await ensureMemoryRetrieval(db, slot.task, "review", slot.head, deps);
  }
  if (before !== claimStamp(db, reviewSlotsFor(db, who.caller), "reviewer") || caller !== callerStamp(who.caller.agent)) {
    return { ok: false, error: "order_changed", message: "记忆检索期间订单或会话已变化，请重新领单" };
  }
  return takeReview(db, identity, dir, true);
}
