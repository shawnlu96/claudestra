import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Feature } from "../lib/ledger-feature.js";
import { getTask } from "../lib/ledger-store.js";
import { currentOrders } from "../lib/order-take.js";
import { fullPrUrl, prConflict } from "../lib/order-deliver-pr.js";
import { slotByOrderId } from "../lib/review-order.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "../lib/order-tool-route.js";
import { parseDeliverWire, parseVerdictWire } from "../lib/order-wire.js";
import { readSharedLedgerMode } from "../lib/shared-ledger-mode.js";
import { id, parseCommand, type V2Command } from "../lib/shared-ledger-contract-v2.js";
import {
  requireSharedExecEntry, sharedExecCommand, sharedExecEntryFailure, sharedExecEntryPort, SharedExecEntryError,
  type EntryTool, type EntryToolContext,
} from "./shared-ledger-v2-entry.js";

export interface EntryLocalDeps {
  db: Database | null;
  modeOf?: typeof readSharedLedgerMode;
}
/** With no route wiring, inspect authority only to prevent an execution card falling through to a local writer.
 * A configured route is the sole routing decision; absent optional mappings hold execution rather than guess.
 */
function routed(target: string, featureId: string | null, project: string | undefined, kind: "task" | "feature", deps: EntryLocalDeps): boolean {
  const p = sharedExecEntryPort();
  const route = kind === "task" ? p?.route?.(target) : p?.featureRoute?.(target);
  if (route === "local") return false;
  if (route === "central") {
    if (project) requireSharedExecEntry(project, true);
    return true;
  }
  if (route === "skip") {
    const reason = p?.holdReason?.(target);
    if (reason === "migrating") throw new SharedExecEntryError(409, reason);
    if (project) requireSharedExecEntry(project, true);
    throw new SharedExecEntryError(503, reason ?? "unavailable");
  }
  const mode = featureId ? (deps.modeOf ?? readSharedLedgerMode)(featureId) : null;
  if (mode && "migrating" in mode && mode.migrating) throw new SharedExecEntryError(409, "migrating");
  if (mode?.authorityMode !== "execution") return false;
  throw new SharedExecEntryError(503, p ? "v2_unmapped" : "unavailable");
}
function taskOfOrder(db: Database | null, orderId: string) {
  if (!db) return null;
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_intents'").get();
  const row = has ? db.query("SELECT taskId FROM scheduler_intents WHERE id=?").get(orderId) as { taskId: string } | null : null;
  return getTask(db, row?.taskId ?? orderId.split(":")[0]!);
}
function errorResult(error: unknown): OrderToolResult {
  const { code } = sharedExecEntryFailure(error);
  return refuse(code, code);
}
async function context(call: VerifiedCall, tool: EntryTool, target: string, wire: unknown): Promise<EntryToolContext> {
  const p = sharedExecEntryPort();
  if (!p) throw new SharedExecEntryError(503, "unavailable");
  if (!p.toolContext) throw new SharedExecEntryError(503, "v2_unmapped");
  const c = await p.toolContext(call, tool, target, wire);
  if (!c) throw new SharedExecEntryError(503, "v2_unmapped");
  requireSharedExecEntry(c.project, true);
  if (c.principal.disabled || c.principal.peer) throw new SharedExecEntryError(403, "forbidden");
  return c;
}
function command(c: EntryToolContext, type: V2Command["type"], payload: unknown, target: string): V2Command {
  // Restart cannot turn a partially committed operation into a new send; changed payload/CAS conflicts on the same receipt key.
  const key = createHash("sha256").update(JSON.stringify([c.scope.teamId, c.scope.projectId, id(c.requestKey), target, type])).digest("hex");
  return parseCommand({ ...c.scope, requestId: `entry-${key}`, type, payload });
}
function stillCentral(target: string, featureId: string | null, project: string, kind: "task" | "feature", deps: EntryLocalDeps): void {
  if (!routed(target, featureId, project, kind, deps)) throw new SharedExecEntryError(503, "unavailable");
}
function executionPayload(c: EntryToolContext) {
  if (!c.task || !c.order) throw new SharedExecEntryError(503, "v2_unmapped");
  return { taskId: c.task.id, expectedRev: c.task.rev, expectedSpecRev: c.task.specRev, expectedWorkflowRev: c.task.workflowRev,
    round: c.task.round, orderId: c.order.id, leaseGen: c.order.leaseGen };
}
export async function sharedExecDeliver(call: VerifiedCall, args: unknown, deps: EntryLocalDeps): Promise<OrderToolResult | null> {
  const parsed = parseDeliverWire(args);
  if (!parsed.ok) return refuse("invalid_wire", parsed.error);
  const w = parsed.value, task = taskOfOrder(deps.db, w.orderId);
  if (!/^[0-9a-f]{40}$/.test(w.head)) return refuse("invalid_wire", "invalid head");
  try {
    if (!routed(task?.id ?? w.orderId, task?.featureId ?? null, task?.project, "task", deps)) return null;
    if (!deps.db || !currentOrders(deps.db, call).some(o => o.orderId === w.orderId)) return refuse("not_current_order", "not_current_order");
    const c = await context(call, "deliver", task!.id, w);
    if (!c.artifactIds || !c.delivery) throw new SharedExecEntryError(503, "v2_unmapped");
    if (c.delivery.head !== w.head) return refuse("head_mismatch", "head_mismatch");
    if (!fullPrUrl(c.delivery.pr)) return refuse("pr_unverifiable", "pr_unverifiable");
    if (prConflict(task!.pr, c.delivery.pr)) return refuse("pr_mismatch", "pr_mismatch");
    const payload = { ...executionPayload(c), head: w.head, artifactIds: c.artifactIds, summary: w.summary };
    stillCentral(task!.id, task!.featureId ?? null, task!.project, "task", deps);
    const receipt = await sharedExecCommand(c.principal, c.project, command(c, "task.deliver", payload, w.orderId));
    return { ok: true, receipt };
  } catch (error) { return errorResult(error); }
}
export async function sharedExecVerdict(call: VerifiedCall, args: unknown, deps: EntryLocalDeps): Promise<OrderToolResult | null> {
  const parsed = parseVerdictWire(args);
  if (!parsed.ok) return refuse("invalid_wire", parsed.error);
  const w = parsed.value, task = taskOfOrder(deps.db, w.orderId);
  try {
    if (!routed(task?.id ?? w.orderId, task?.featureId ?? null, task?.project, "task", deps)) return null;
    if (!call.sessionId || !["claude-code", "codex"].includes(call.family ?? "")) return refuse("identity_incomplete", "identity_incomplete");
    if (!deps.db || !slotByOrderId(deps.db, w.orderId, call)) return refuse("not_current_order", "not_current_order");
    const c = await context(call, "submit_verdict", task!.id, w);
    if (!c.reportArtifactId) throw new SharedExecEntryError(503, "v2_unmapped");
    if (c.task?.head !== w.head) return refuse("head_mismatch", "head_mismatch");
    const payload = { ...executionPayload(c), head: w.head, verdict: w.verdict, reportArtifactId: c.reportArtifactId };
    stillCentral(task!.id, task!.featureId ?? null, task!.project, "task", deps);
    const receipt = await sharedExecCommand(c.principal, c.project, command(c, "task.review", payload, w.orderId));
    return { ok: true, receipt };
  } catch (error) { return errorResult(error); }
}
export async function sharedExecStart(call: VerifiedCall, f: Feature, key: string, args: unknown,
  deps: EntryLocalDeps): Promise<OrderToolResult | null> {
  try {
    if (!routed(f.id, f.id, f.project, "feature", deps)) return null;
    if (!key) return refuse("invalid", "缺节点 key");
    const c = await context(call, "start_node", f.id, args);
    if (!c.start || c.start.nodeKey !== key) throw new SharedExecEntryError(503, "v2_unmapped");
    stillCentral(f.id, f.id, f.project, "feature", deps);
    const created = await sharedExecCommand(c.principal, c.project, command(c, "task.new", c.start.payload, `${f.id}:${key}`));
    // Re-read routing/mode between the two writes: revoked authority must stop binding.
    if (!routed(f.id, f.id, f.project, "feature", deps)) throw new SharedExecEntryError(503, "unavailable");
    const payload = { featureId: c.start.featureId, expectedRev: c.start.expectedRev, baseVersion: c.start.baseVersion,
      nodeKey: key, taskId: created.result.entityId, expectedTaskRev: created.result.rev };
    const bound = await sharedExecCommand(c.principal, c.project, command(c, "dag.bind", payload, `${f.id}:${key}`));
    return { ok: true, taskId: created.result.entityId, receipt: bound };
  } catch (error) { return errorResult(error); }
}
