/** S2C intent rules, as the stage-two client drives them: an intent's id is its operationId, a claimed (submitted) intent
 * can be checked again and again without changing anything, the first operation result stands, and cancelling is the
 * owner's (any live state) or the home scheduler service's (pending only). Test fixture only — not a center reference.
 */
import { assertFence, fail, v2ObjectDigest, type V2Intent } from "../../src/lib/shared-ledger-contract-v2.js";
import { resourcesOverlap } from "../../src/lib/shared-ledger-contract-v2-scheduling.js";
import type { CommandContext, CommandResult } from "./shared-ledger-v2-fake-center-commands.js";
import { authorizeAsk, executionAt, fenceOf, must, requireLease } from "./shared-ledger-v2-fake-center-state.js";

type Context = Pick<CommandContext, "state" | "command" | "now">;
const receiptOf = (intent: V2Intent): CommandResult => ({ entityId: intent.id, rev: 1 });

/** Looked up by operationId; a payload naming another intent id (or another task) for that operation is a conflict. */
function intentOf(ctx: Context, ref: { intentId: string; operationId: string; taskId?: string }): V2Intent {
  const intent = must(ctx.state.intents.get(ref.operationId));
  if (intent.id !== ref.intentId || (ref.taskId !== undefined && intent.taskId !== ref.taskId)) fail("conflict");
  return intent;
}
/** The intent's own lease term is still the live one: a later term (another boot, or the same boot after the lease
 * lapsed) gets stale_epoch / lease_expired and the intent keeps its locks for explicit reconciliation. */
function assertTerm(ctx: Context, intent: V2Intent): void {
  const lease = requireLease(ctx.state, intent.taskId, ctx.command, ctx.now);
  assertFence(fenceOf(lease), fenceOf(intent));
  if (ctx.state.intentTerms.get(intent.id) !== ctx.state.leaseTerms.get(intent.taskId)) fail("lease_expired");
}
/** Terminal states free the intent's locks, unknown keeps them marked unknown (never silently released). */
function settle(ctx: Context, intent: V2Intent, patch: Partial<V2Intent> & { status: V2Intent["status"] }): CommandResult {
  const { state } = ctx;
  state.intents.set(intent.id, { ...intent, ...patch, updatedAt: ctx.now });
  if (patch.status === "done" || patch.status === "cancelled") state.resources = state.resources.filter(r => r.intentId !== intent.id);
  if (patch.status === "unknown") state.resources = state.resources.map(r => r.intentId === intent.id ? { ...r, state: "unknown" } : r);
  return receiptOf(intent);
}

export function intentCreate(ctx: CommandContext<"intent.create">): CommandResult {
  const { command: c, state, now } = ctx, p = c.payload, task = executionAt(ctx, p), id = p.operationId;
  requireLease(state, p.taskId, c, now);
  authorizeAsk(state, p.authorizationAskId, now);
  if (state.intents.has(id)) fail("conflict");
  if (state.resources.some(r => p.resources.some(k => resourcesOverlap(k, r.key)))) fail("resource_busy");
  const workflow = must(state.workflows.get(p.taskId));
  state.intents.set(id, {
    teamId: c.teamId, projectId: c.projectId, id, taskId: p.taskId, homeInstanceId: task.homeInstanceId,
    executorInstanceId: task.executorInstanceId, ...fenceOf(c), node: p.node, action: p.action, operationId: id, taskRev: task.rev,
    specRev: task.specRev, workflowRev: workflow.rev, templateVersion: workflow.templateVersion, head: p.head, round: p.round,
    dependencyDigest: p.dependencyDigest, authorizationAskId: p.authorizationAskId, authorizationDigest: p.authorizationDigest,
    resources: p.resources, causalSeq: 0, eventSeq: ctx.seq, status: "pending", attempts: 0, reason: "", createdAt: now, updatedAt: now,
  });
  state.intentTerms.set(id, must(state.leaseTerms.get(p.taskId)));
  for (const key of p.resources) state.resources.push({ key, taskId: p.taskId, intentId: id, operationId: id,
    ...fenceOf(c), scope: "intent", state: "held", acquiredAt: now });
  return { entityId: id, rev: 1 };
}

/** pending → submitted on the first pass; on a submitted intent the same checks run and nothing is written. The request's
 * versions, the versions frozen in the intent and the center's current task / workflow must all agree, and the request
 * must carry the very authorization the intent was created with (another valid approval is still a mismatch). */
export function intentCheck(ctx: CommandContext<"intent.check">): CommandResult {
  const { state } = ctx, p = ctx.command.payload, intent = intentOf(ctx, p);
  if (intent.status !== "pending" && intent.status !== "submitted") fail("unknown_operation");
  const task = executionAt(ctx, p), workflow = must(state.workflows.get(p.taskId));
  if (intent.taskRev !== task.rev || intent.specRev !== task.specRev || intent.workflowRev !== workflow.rev
    || intent.head !== task.head || intent.round !== task.round) fail("conflict");
  if (p.authorizationAskId !== intent.authorizationAskId || p.authorizationDigest !== intent.authorizationDigest) fail("authorization_mismatch");
  authorizeAsk(state, intent.authorizationAskId, ctx.now);
  assertTerm(ctx, intent);
  return intent.status === "pending" ? settle(ctx, intent, { status: "submitted", attempts: 1 }) : receiptOf(intent);
}

/** The owner's approval as the center holds it now: answered approved, unexpired, and bound to exactly what the command
 * says it is using it for (same bind, an action the bind lists, this task at these versions). Writes nothing. */
export function authorizationCheck(ctx: CommandContext<"authorization.check">): CommandResult {
  const { state } = ctx, p = ctx.command.payload;
  executionAt(ctx, p);
  const ask = state.asks.get(p.askId), bind = ask?.kind === "authorize" ? ask.bind : null;
  if (!ask || !bind) return fail("authorization_mismatch");
  authorizeAsk(state, ask.id, ctx.now);
  const pinned = (bound: string | number | null, used: string | number) => bound === null || bound === used;
  if (v2ObjectDigest(bind) !== v2ObjectDigest(p.bind) || !(bind.actions as string[]).includes(p.action) || !pinned(bind.taskId, p.taskId)
    || !pinned(bind.taskRev, p.expectedRev) || !pinned(bind.specRev, p.expectedSpecRev)
    || !pinned(bind.workflowRev, p.expectedWorkflowRev)) fail("authorization_mismatch");
  return { entityId: ask.id, rev: ask.rev };
}

/** Recorded only from submitted, within the intent's lease term. The first result per operationId is kept: a later report
 * (another requestId, even another outcome) is acknowledged for its own request and changes nothing. */
export function operationResult(ctx: CommandContext<"operation.result">): CommandResult {
  const { state } = ctx, r = ctx.command.payload.result, intent = intentOf(ctx, { intentId: r.intentId, operationId: r.operationId });
  if (intent.taskId !== r.taskId || r.epoch !== intent.epoch || r.bootId !== intent.bootId) fail("stale_epoch");
  if (intent.status === "unknown") fail("unknown_operation");
  if (state.operationResults.has(intent.operationId)) return receiptOf(intent);
  if (intent.status !== "submitted") fail("conflict");
  assertTerm(ctx, intent);
  state.operationResults.set(intent.operationId, r);
  return settle(ctx, intent, { status: r.state === "unknown" ? "unknown" : "done" });
}

/** Already cancelled is an idempotent success, done a conflict. The owner in person needs only the home instance (checked
 * before any handler) and current versions — no live lease, so a lapsed or re-termed submitted / unknown intent can still
 * be withdrawn. The registered home scheduler service, acting without an order, may withdraw only what it has not claimed
 * yet (pending), under its live lease term. Everyone else is forbidden. */
export function intentCancel(ctx: CommandContext<"intent.cancel">): CommandResult {
  const { state, actor } = ctx, p = ctx.command.payload, intent = intentOf(ctx, p);
  if (intent.status === "cancelled") return receiptOf(intent);
  if (intent.status === "done") fail("conflict");
  if (actor.kind === "person") {
    if (ctx.role !== "owner") fail("forbidden");
    executionAt(ctx, p);
  } else {
    if (actor.orderId !== null || actor.serviceId !== state.homeSchedulerServiceId) fail("forbidden");
    if (actor.instanceId !== must(ctx.feature).homeInstanceId) fail("wrong_home");
    if (intent.status !== "pending") fail("forbidden");
    executionAt(ctx, p);
    assertTerm(ctx, intent);
  }
  return settle(ctx, intent, { status: "cancelled", reason: p.reason });
}
