/** Work-order text shared by every local route; the format itself is OrderWire (order-wire.ts), rendered for this machine. */
import { orderWireOf } from "./order-wire.js";
import { renderOrderWire } from "./order-wire-render.js";
import type { WorkOrder } from "./worker-session.js";

/** The dedup key is repeated verbatim so a worker (or a later reconcile) can match the reply to this exact intent. */
export function renderWorkOrder(order: WorkOrder): string {
  return renderOrderWire(orderWireOf(order), { audience: "local" });
}
