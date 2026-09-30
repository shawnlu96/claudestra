/** Work-order text shared by every local route; the format itself is OrderWire (order-wire.ts), rendered for this machine. */
import { orderWireOf } from "./order-wire.js";
import { renderOrderWire } from "./order-wire-render.js";
import type { WorkOrder } from "./worker-session.js";

/**
 * A wake-mode order sends only this line: the order itself stays in the ledger and the worker pulls it with take_order /
 * take_review, so a lost or duplicated line never carries a second copy of the work. The key is the intent id (= orderId).
 */
function renderWakeLine(order: WorkOrder): string {
  const [take, give] = order.step === "review" ? ["take_review", "submit_verdict"] : ["take_order", "deliver"];
  return `【调度派单】有新单 ${order.dedupKey}（${order.taskId} · ${order.step} · 第 ${order.round} 轮）：调用 ${take} 领取，按单子做，完成用 ${give} 回写。`;
}

/** The dedup key is repeated verbatim so a worker (or a later reconcile) can match the reply to this exact intent. */
export function renderWorkOrder(order: WorkOrder): string {
  return order.delivery?.mode === "wake" ? renderWakeLine(order) : renderOrderWire(orderWireOf(order), { audience: "local" });
}
