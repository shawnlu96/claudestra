/**
 * 唤醒派单只发一句话，单子要收件人自己用 take_order / take_review 领。所以发唤醒前，按领单工具的同一口径把这张单构造一遍：
 * 构造不出来（台账里有脏值、找不到这张单），就别发唤醒，调用方改发全文并写明原因——否则收件人被叫醒了却领不到。
 * 口径：执行单 = order-take.ts currentOrders + orderWireFor；审查单 = review-order.ts reviewOrderOf（槽位按这条意图现拼）。
 */
import type { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { currentOrders, orderWireFor } from "./order-take.js";
import { reviewOrderOf } from "./review-order.js";
import type { SessionRef } from "./worker-session.js";

/** 领得到返回 null；领不到返回原因（一句话） */
export function unpullableReason(db: Database, ref: SessionRef, intent: SchedulerIntent): string | null {
  const task = getTask(db, intent.taskId);
  if (!task) return `台账里没有卡 ${intent.taskId}`;
  if (ref.role === "reviewer") {
    const head = intent.head ?? task.headSHA;
    if (!head) return "审查单没有 head";
    const r = reviewOrderOf(db, { task, orderId: intent.id, node: intent.node, head, auto: true });
    return r.ok ? null : r.error;
  }
  const order = currentOrders(db, { agent: ref.agent, sessionId: ref.sessionId, family: null, channelId: "" }).find((o) => o.orderId === intent.id);
  if (!order) return "take_order 按当前台账找不到这张单";
  const r = orderWireFor(db, order);
  return r.ok ? null : r.error;
}
