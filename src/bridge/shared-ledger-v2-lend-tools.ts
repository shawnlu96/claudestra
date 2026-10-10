import type { Database } from "bun:sqlite";
import type { CallerIdentity } from "../lib/caller-identity.js";
import { liveOrders, WORKER_STATES, type LendRow } from "../lib/lend-journal.js";
import { readReportIn } from "../lib/lend-submit.js";
import { refuse, type OrderToolResult } from "../lib/order-tool-route.js";
import { parseDeliverWire, parseVerdictWire } from "../lib/order-wire.js";
import { runtimeFamily } from "../lib/scheduler-auto-review.js";
import { isLendWorkerName } from "../lib/runtimes/clean-env.js";
import { fail, V2ContractError } from "../lib/shared-ledger-contract-v2.js";
import { LendCentralMigrating, lendCentralRoutingEnabled, lendCentralWire, openLendCentral, type BoundLendCentral } from "./shared-ledger-v2-lend.js";

function workerMatches(row: LendRow, identity: CallerIdentity, bound: BoundLendCentral): void {
  const b = bound.entry.binding;
  if (!row.sessionId || row.sessionId !== identity.sessionId) return fail("forbidden");
  if (!WORKER_STATES.includes(row.state) || row.fp !== b.fp || row.peer !== b.peer
    || row.leaseGen !== b.order.leaseGen || b.worker.kind === "human" || b.worker.agentId !== identity.agent
    || !identity.family || runtimeFamily(identity.family) !== b.order.family) return fail("forbidden");
}
async function deliver(tool: string, args: unknown, row: LendRow, bound: BoundLendCentral): Promise<OrderToolResult> {
  const order = bound.entry.binding.order, write = order.step !== "review";
  if (write !== (tool === "deliver")) return refuse("wrong_step", "工具与本单步骤不符");
  const parsed = write ? parseDeliverWire(args) : parseVerdictWire(args);
  if (!parsed.ok) return refuse("invalid_args", parsed.error);
  let report: string | undefined;
  if (!write) {
    const read = readReportIn(row.dir ?? "", (parsed.value as { reportPath: string }).reportPath);
    if (!read.ok) return refuse("bad_report", read.error);
    report = read.text;
  }
  const wire = { v: 1, orderId: order.orderId, gen: order.leaseGen, session: { id: row.sessionId, family: order.family },
    ...(write ? { deliver: parsed.value, branch: order.branch, pr: order.pr } : { verdict: parsed.value, report }) };
  const outcome = await bound.client.result(wire, bound.sharedResult());
  // S2F owns explicit recovery and receipt/worker settlement; an outbox entry is not a completed delivery.
  if (outcome.status !== "confirmed") {
    const pending = { ok: false as const, code: "unavailable", error: "中心结果未确认；须显式恢复后核对回执",
      orderId: order.orderId, ...outcome };
    return pending;
  }
  return { ok: true, orderId: order.orderId, ...outcome };
}

/** null delegates to the original tool router. Identity and order come from the worker journal, never its arguments. */
export async function sharedLendTool(tool: unknown, identity: CallerIdentity, args: unknown, db: Database | null): Promise<OrderToolResult | null> {
  if (!lendCentralRoutingEnabled() || !identity.verified || !isLendWorkerName(identity.agent ?? undefined) || !db) return null;
  const rows = liveOrders(db).filter(row => row.agent === identity.agent);
  if (rows.length !== 1) return null; // The existing router owns missing/conflicting worker bindings.
  const row = rows[0]!;
  try {
    const bound = await openLendCentral(row.orderId, row.wire?.order.taskId as string | undefined);
    if (!bound) return null;
    workerMatches(row, identity, bound);
    const raw = lendCentralWire(args);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_field");
    const given = (raw as { orderId?: unknown }).orderId;
    if (given !== undefined && given !== row.orderId) return fail("forbidden");
    const write = bound.entry.binding.order.step !== "review";
    if (tool === "take_order" || tool === "take_review") {
      if (write !== (tool === "take_order")) return refuse("wrong_step", "工具与本单步骤不符");
      if (!row.wire) return fail("unavailable");
      return { ok: true, orders: [row.wire.order], errors: [], brief: row.wire.text };
    }
    if (tool === "deliver" || tool === "submit_verdict") return await deliver(tool, raw, row, bound);
    if (tool === "ask") return null;
    return refuse("forbidden", "worker 只可操作自己的出借订单");
  } catch (error) {
    if (error instanceof V2ContractError || error instanceof LendCentralMigrating) return refuse(error.code, error.message);
    console.warn(`⚠️ [lend central] ${String(error)}`);
    return refuse("unavailable", "中心出借 journal 或传输不可用");
  }
}
