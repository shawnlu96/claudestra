/** Preflight uses the final delivery planner, without applying its plan or granting delivery permission. */
import type { Database } from "bun:sqlite";
import { mustTask } from "./ledger-checks.js";
import { uiDeliverPort } from "./ledger-deliver-ui-port.js";
import { planUiDelivery, type UiDeliverPeer, type UiDeliverPort } from "./ledger-deliver-ui.js";
import { getLendOrder } from "./ledger-lend.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";

export interface UiTakeoverRefusal { task: LedgerTask; port: UiDeliverPort; code: string; reason: string }
export type TakeoverUiPort = (peer: UiDeliverPeer) => UiDeliverPort;

/** No takeover manifest exists in this protocol. Files alone never stand in for a bound, validated delivery manifest. */
export function uiTakeoverRefusal(db: Database, orderId: string, head: string, make: TakeoverUiPort = (peer) => uiDeliverPort({ peer })): UiTakeoverRefusal | null {
  const o = getLendOrder(db, orderId);
  if (!o?.worker) throw new LedgerError("conflict", "接管单已不在 worker 手里");
  const task = mustTask(db, o.taskId);
  if (getWorkflow(db, task.id)?.template !== "ui") return null;
  const port = make({ peer: o.peer, worker: o.worker, orderId });
  const policy = port.mode(task.project);
  if (policy.diagnostic) return { task, port, code: "policy_unreadable", reason: "UI 交付策略读失败，保守停止接管" };
  if (policy.mode !== "on") return null;
  try {
    planUiDelivery(db, task, { headSHA: head }, { mode: () => policy, observe: port.observe, peer: port.peer, get roots() { return port.roots; } });
    return null;
  } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    return { task, port, code: String(e.current?.ui ?? e.code), reason: e.message };
  }
}
