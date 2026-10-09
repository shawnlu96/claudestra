/** S2C fake center: per-command minimal semantics on a draft state (the core commits the draft only when the handler returns).
 * Modeled: feature / task / workflow / ask / lease / intent / operation / lend create-claim-result / home.change.
 * Anything else answers conflict ("not modeled") unless the test passes its own handler. Not a center reference.
 */
import {
  assertFence, fail, v2ObjectDigest, V2_LEASE_MS,
  type V2Actor, type V2Command, type V2Feature, type V2Intent, type V2LendOrder, type V2Task,
} from "../../src/lib/shared-ledger-contract-v2.js";
import { resourcesOverlap } from "../../src/lib/shared-ledger-contract-v2-scheduling.js";
import { authorizeAsk, fenceOf, must, newLease, requireLease, type FakeCenterState } from "./shared-ledger-v2-fake-center-state.js";

type C<K extends V2Command["type"]> = Extract<V2Command, { type: K }>;
interface ContextBase {
  state: FakeCenterState; command: V2Command; actor: V2Actor; now: number; feature: V2Feature | null;
  /** The serverSeq this command commits at; also the source of center-assigned ids. */
  seq: number;
}
interface CommandContext<K extends V2Command["type"] = V2Command["type"]> extends ContextBase { command: C<K> }
type CommandResult = { entityId: string; rev: number; specRev?: number | null; version?: number | null };
export type CommandHandler<K extends V2Command["type"] = V2Command["type"]> = (ctx: CommandContext<K>) => CommandResult;
export type CommandHandlers = { [K in V2Command["type"]]?: CommandHandler<K> };

function taskAt(ctx: ContextBase, p: { taskId: string; expectedRev: number; expectedSpecRev: number }): V2Task {
  const task = must(ctx.state.tasks.get(p.taskId));
  if (task.rev !== p.expectedRev || task.specRev !== p.expectedSpecRev) fail("conflict");
  return task;
}
function executionAt(ctx: ContextBase, p: { taskId: string; expectedRev: number; expectedSpecRev: number; expectedWorkflowRev: number }) {
  const task = taskAt(ctx, p), workflow = ctx.state.workflows.get(p.taskId);
  if (workflow && workflow.rev !== p.expectedWorkflowRev) fail("conflict");
  return task;
}
const touch = <T extends { rev: number; updatedAt: number }>(row: T, now: number, patch: Partial<T> = {}): T =>
  ({ ...row, ...patch, rev: row.rev + 1, updatedAt: now });
const scope = (c: { teamId: string; projectId: string }) => ({ teamId: c.teamId, projectId: c.projectId });

function taskNew(ctx: CommandContext<"task.new">): CommandResult {
  const { command: c, now } = ctx, p = c.payload, feature = must(ctx.feature);
  if (feature.rev !== p.expectedRev) fail("conflict");
  const id = `task-${ctx.seq}`;
  ctx.state.tasks.set(id, {
    ...scope(c), id, itemId: p.itemId, featureId: feature.id, title: p.title, plan: p.plan, kind: p.kind, stage: "spec",
    stageBefore: null, round: 0, specRev: 1, rev: 1, createdAt: now, updatedAt: now, homeInstanceId: feature.homeInstanceId,
    executor: null, executorInstanceId: null, pm: null, repository: p.repository, branch: null, pr: null, head: null, spec: p.spec,
    collaboration: { reviewer: null, delegate: null }, review: { verdict: null, reviewedHead: null, reportArtifactId: null },
    delivery: { orderId: null, summary: "", artifactIds: [] },
  });
  return { entityId: id, rev: 1, specRev: 1 };
}
function intentCreate(ctx: CommandContext<"intent.create">): CommandResult {
  const { command: c, state, now } = ctx, p = c.payload, task = executionAt(ctx, p);
  requireLease(state, p.taskId, c, now);
  authorizeAsk(ctx.state, p.authorizationAskId, ctx.now);
  if ([...state.intents.values()].some(i => i.operationId === p.operationId)) fail("conflict");
  if (state.resources.some(r => p.resources.some(k => resourcesOverlap(k, r.key)))) fail("resource_busy");
  const id = `intent-${ctx.seq}`, workflow = must(state.workflows.get(p.taskId));
  state.intents.set(id, {
    ...scope(c), id, taskId: p.taskId, homeInstanceId: task.homeInstanceId, executorInstanceId: task.executorInstanceId, ...fenceOf(c),
    node: p.node, action: p.action, operationId: p.operationId, taskRev: task.rev, specRev: task.specRev, workflowRev: workflow.rev,
    templateVersion: workflow.templateVersion, head: p.head, round: p.round, dependencyDigest: p.dependencyDigest,
    authorizationAskId: p.authorizationAskId, authorizationDigest: p.authorizationDigest, resources: p.resources,
    causalSeq: 0, eventSeq: ctx.seq, status: "pending", attempts: 0, reason: "", createdAt: now, updatedAt: now,
  });
  for (const key of p.resources) state.resources.push({ key, taskId: p.taskId, intentId: id, operationId: p.operationId,
    ...fenceOf(c), scope: "intent", state: "held", acquiredAt: now });
  return { entityId: id, rev: 1 };
}
/** Moves a live intent, only within the lease term that created it: a later term (another boot, or the same boot after the
 * lease lapsed) gets stale_epoch / lease_expired and the intent keeps its locks for explicit reconciliation.
 * Terminal states free its locks, unknown keeps them marked unknown (never silently released). */
function settleIntent(ctx: ContextBase, intentId: string, operationId: string, from: readonly V2Intent["status"][],
  to: "submitted" | "done" | "cancelled" | "unknown") {
  const { state, now } = ctx, intent = must(state.intents.get(intentId));
  if (intent.operationId !== operationId || !from.includes(intent.status)) fail("conflict");
  const lease = requireLease(state, intent.taskId, ctx.command, now);
  assertFence(fenceOf(lease), fenceOf(intent));
  if (intent.createdAt < lease.acquiredAt) fail("lease_expired");
  state.intents.set(intentId, { ...intent, status: to, attempts: intent.attempts + (to === "submitted" ? 1 : 0), updatedAt: now });
  if (to === "done" || to === "cancelled") state.resources = state.resources.filter(r => r.intentId !== intentId);
  if (to === "unknown") state.resources = state.resources.map(r => r.intentId === intentId ? { ...r, state: "unknown" } : r);
  return { entityId: intentId, rev: 1 };
}
function lendCreate(ctx: CommandContext<"lend.create">): CommandResult {
  const { command: c, state, now, actor } = ctx, p = c.payload, task = executionAt(ctx, p);
  requireLease(state, p.taskId, c, now);
  const orderId = `order-${ctx.seq}`;
  const order: V2LendOrder = {
    ...scope(c), orderId, taskId: p.taskId, specRev: task.specRev, round: p.round, head: p.head, leaseGen: 0, featureId: p.featureId,
    homeInstanceId: task.homeInstanceId, executorInstanceId: p.executorInstanceId, ...fenceOf(c), family: p.family, step: p.step,
    repository: task.repository, pr: task.pr, branch: p.branch, base: p.base, specArtifactId: p.specArtifactId, grantId: p.grantId,
    grantDigest: p.grantDigest, authorizationAskId: null, status: "pooled", worker: null, leaseMs: V2_LEASE_MS, leaseUntil: null,
    resultDigest: null, resultOperationId: null, eventSeq: ctx.seq, supersedes: null, createdBy: actor.personId,
    createdAt: now, updatedAt: now, seenAt: null,
  };
  state.orders.set(orderId, order);
  return { entityId: orderId, rev: 1 };
}
function lendClaim(ctx: CommandContext<"lend.claim">): CommandResult {
  const { state, now, actor } = ctx, claim = ctx.command.payload.claim, order = must(state.orders.get(claim.orderId));
  if (actor.instanceId !== claim.executorInstanceId) fail("forbidden");
  if (order.status !== "pooled" || claim.leaseGen !== order.leaseGen + 1 || claim.specRev !== order.specRev
    || claim.round !== order.round || claim.head !== order.head || claim.grantId !== order.grantId
    || (order.executorInstanceId !== null && order.executorInstanceId !== claim.executorInstanceId)) fail("stale_order");
  const leaseUntil = now + order.leaseMs;
  state.orders.set(order.orderId, { ...order, status: "claimed", leaseGen: claim.leaseGen, executorInstanceId: claim.executorInstanceId,
    worker: claim.worker, leaseUntil, updatedAt: now });
  state.lendLeases.set(order.orderId, { ...scope(order), orderId: order.orderId, taskId: order.taskId, ...fenceOf(order),
    leaseGen: claim.leaseGen, executorInstanceId: claim.executorInstanceId, worker: claim.worker, renewedAt: now,
    expiresAt: leaseUntil, leaseMs: order.leaseMs });
  return { entityId: order.orderId, rev: claim.leaseGen };
}
/** A result lands only from the claiming worker, on the claimed version / head / fence, while the central lend lease lives. */
function lendResult(ctx: CommandContext<"lend.result">): CommandResult {
  const { state, now, actor } = ctx, r = ctx.command.payload.result, order = must(state.orders.get(r.orderId));
  if (actor.instanceId !== r.executorInstanceId) fail("forbidden");
  if (order.status !== "claimed") fail("stale_order");
  if (r.leaseGen !== order.leaseGen || r.executorInstanceId !== order.executorInstanceId) fail("stale_lease_gen");
  if (v2ObjectDigest(r.worker) !== v2ObjectDigest(order.worker)) fail("forbidden");
  if (r.taskId !== order.taskId || r.specRev !== order.specRev || r.round !== order.round || r.expectedHead !== order.head) fail("stale_order");
  assertFence(fenceOf(order), fenceOf(r));
  const lease = state.lendLeases.get(order.orderId);
  if (!lease || lease.expiresAt <= now) fail("lease_expired");
  state.orders.set(order.orderId, { ...order, status: r.verdict === "unknown" ? "unknown" : "done", resultDigest: r.resultDigest,
    resultOperationId: r.operationId, leaseUntil: null, updatedAt: now });
  state.lendLeases.delete(order.orderId);
  return { entityId: order.orderId, rev: order.leaseGen };
}

export const COMMAND_HANDLERS: CommandHandlers = {
  "feature.new": ({ command: c, state, now, actor, seq }) => {
    const id = `feature-${seq}`;
    state.features.set(id, { ...scope(c), id, title: c.payload.title, description: c.payload.description, ownerWords: "",
      ownerWordsBy: actor.personId, authorityMode: "planning", homeInstanceId: c.payload.homeInstanceId, epoch: c.epoch,
      status: "active", currentVersion: 0, rev: 1, createdAt: now, updatedAt: now });
    return { entityId: id, rev: 1, version: 0 };
  },
  "feature.set": ({ command: { payload: p }, state, now }) => {
    const f = must(state.features.get(p.featureId));
    if (f.rev !== p.expectedRev) fail("conflict");
    const next = touch(f, now, { ...(p.title === undefined ? {} : { title: p.title }), ...(p.description === undefined ? {} : { description: p.description }) });
    state.features.set(f.id, next);
    return { entityId: f.id, rev: next.rev, version: next.currentVersion };
  },
  "task.new": taskNew,
  "task.set": ctx => {
    const p = ctx.command.payload, next = touch(taskAt(ctx, p), ctx.now, p.patch);
    ctx.state.tasks.set(next.id, next);
    return { entityId: next.id, rev: next.rev, specRev: next.specRev };
  },
  "task.stage": ctx => {
    const p = ctx.command.payload, task = executionAt(ctx, p);
    requireLease(ctx.state, p.taskId, ctx.command, ctx.now);
    authorizeAsk(ctx.state, p.authorizationAskId, ctx.now);
    if (task.stage !== p.from) fail("conflict");
    const next = touch(task, ctx.now, { stage: p.to, round: p.round, stageBefore: p.to === "blocked" ? p.from : null });
    ctx.state.tasks.set(next.id, next);
    return { entityId: next.id, rev: next.rev, specRev: next.specRev };
  },
  "workflow.set": ctx => {
    const { command: c, state, now } = ctx, p = c.payload, task = executionAt(ctx, p), prior = state.workflows.get(p.taskId);
    authorizeAsk(ctx.state, p.authorizationAskId, ctx.now);
    const settings = { template: p.template, templateVersion: p.templateVersion, mode: p.mode, authorFamily: p.authorFamily, fallback: p.fallback };
    const next = prior ? touch(prior, now, { ...settings, specRev: task.specRev })
      : { ...scope(c), taskId: p.taskId, ...settings, specRev: task.specRev, rev: 1, createdAt: now, updatedAt: now };
    state.workflows.set(p.taskId, next);
    return { entityId: p.taskId, rev: next.rev, specRev: task.specRev };
  },
  "ask.create": ({ command: c, state, now, actor, seq }) => {
    const id = `ask-${seq}`;
    state.asks.set(id, { ...scope(c), id, ...c.payload, source: "business", state: "open", rev: 1, createdBy: actor.personId,
      createdAt: now, answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: seq });
    return { entityId: id, rev: 1 };
  },
  "ask.answer": ({ command: { payload: p }, state, now, actor }) => {
    const ask = must(state.asks.get(p.askId));
    if (ask.state !== "open" || ask.rev !== p.expectedRev) fail("conflict");
    if (ask.expiresAt <= now) fail("authorization_expired");
    state.asks.set(ask.id, { ...ask, rev: ask.rev + 1, state: "answered", answer: p.answer, decision: p.decision,
      answeredBy: actor.personId, answeredAt: now });
    return { entityId: ask.id, rev: ask.rev + 1 };
  },
  "lease.acquire": ({ command: c, state, now, feature }) => {
    const f = must(feature), held = state.leases.get(c.payload.taskId);
    if (c.payload.homeInstanceId !== f.homeInstanceId) fail("wrong_home");
    const live = held && held.expiresAt > now ? held : null;
    if (live && live.bootId !== c.bootId) fail("resource_busy");
    // Re-acquiring a live lease from the same boot stays in its term, so intents created in it can still settle.
    state.leases.set(c.payload.taskId, { ...newLease(c, f.homeInstanceId, now), ...(live ? { acquiredAt: live.acquiredAt } : {}) });
    return { entityId: c.payload.taskId, rev: must(state.tasks.get(c.payload.taskId)).rev };
  },
  "lease.renew": ({ command: c, state, now }) => {
    const lease = requireLease(state, c.payload.taskId, c, now);
    state.leases.set(c.payload.taskId, { ...lease, renewedAt: now, expiresAt: now + V2_LEASE_MS });
    return { entityId: c.payload.taskId, rev: must(state.tasks.get(c.payload.taskId)).rev };
  },
  "lease.release": ({ command: c, state, now }) => {
    requireLease(state, c.payload.taskId, c, now);
    state.leases.delete(c.payload.taskId);
    return { entityId: c.payload.taskId, rev: must(state.tasks.get(c.payload.taskId)).rev };
  },
  "intent.create": intentCreate,
  "intent.check": ctx => {
    const p = ctx.command.payload;
    executionAt(ctx, p);
    authorizeAsk(ctx.state, p.authorizationAskId, ctx.now);
    return settleIntent(ctx, p.intentId, p.operationId, ["pending"], "submitted");
  },
  "intent.cancel": ctx => {
    const p = ctx.command.payload;
    executionAt(ctx, p);
    return settleIntent(ctx, p.intentId, p.operationId, ["pending", "submitted"], "cancelled");
  },
  "operation.result": ctx => {
    const r = ctx.command.payload.result, intent = must(ctx.state.intents.get(r.intentId));
    if (intent.taskId !== r.taskId || r.epoch !== intent.epoch || r.bootId !== intent.bootId) fail("stale_epoch");
    return settleIntent(ctx, r.intentId, r.operationId, ["pending", "submitted"], r.state === "unknown" ? "unknown" : "done");
  },
  "lend.create": lendCreate,
  "lend.claim": lendClaim,
  "lend.result": lendResult,
  "home.change": ctx => {
    const { command: { payload: p }, state, now } = ctx, f = must(ctx.feature);
    authorizeAsk(ctx.state, p.authorizationAskId, ctx.now);
    if (f.rev !== p.expectedRev) fail("conflict");
    state.features.set(f.id, touch(f, now, { homeInstanceId: p.nextHomeInstanceId, epoch: p.nextEpoch }));
    for (const t of state.tasks.values()) if (t.featureId === f.id) {
      state.tasks.set(t.id, { ...t, homeInstanceId: p.nextHomeInstanceId });
      state.leases.delete(t.id);
    }
    return { entityId: f.id, rev: f.rev + 1, version: f.currentVersion };
  },
};
