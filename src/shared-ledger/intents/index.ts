import {
  assertTransactionContext, fail, parseCommand, parseIntent, parseEvent, parseOperationResult, resourcesOverlap,
  v2ObjectDigest, type V2Intent, type V2OperationResult, type V2DomainModule, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import {
  checkFence, assertScope, currentRows, assertVersion, assertDependencies, assertAuthorization, assertReconciliation,
  type IntentPorts, type IntentCommand, type IntentCurrent,
} from "./checks.js";
import { intentSchema, getIntent, getResources, getResult, holdResources, markUnknown, saveIntent } from "./storage.js";
export { intentSchema, intentStatements } from "./storage.js";
export { intentActionDigest, intentAuthorizationDigest } from "./checks.js";
export type { IntentPorts, IntentCommand } from "./checks.js";

export interface IntentOutcome { intent: V2Intent; result: V2OperationResult | null }
/** Checking the central intent and performing a remote side effect are NOT atomic: no general exactly-once promise.
 * intent.check consumes the pending permission once. Lost replies/results must be reported as unknown or reconciled;
 * neither lease expiry nor repeated create/check can grant another attempt. X12 owns the transaction and event sequence.
 * Reconcile unknown before changing boot/epoch; old fences are rejected even for explicit reconciliation.
 */
export function createIntentDomain(ports: IntentPorts): V2DomainModule<IntentCommand, IntentOutcome> {
  return {
    installSchema(ctx) { for (const name of Object.keys(intentSchema)) ctx.install(name); },
    applyInTransaction(ctx, input) {
      assertTransactionContext(ctx);
      const command = parseCommand(input) as IntentCommand;
      if (!["intent.create", "intent.check", "intent.cancel", "operation.result", "operation.reconcile"].includes(command.type)) fail("forbidden");
      assertScope(ctx, command); checkFence(ctx.scope, command);
      if (!ctx.scope.actor.actions.includes(command.type)) fail("forbidden");
      if (command.type === "intent.create") return create(ctx, ports, command);
      const p = command.payload, operationId = "result" in p ? p.result.operationId : p.operationId;
      const intent = getIntent(ctx, operationId)?.intent;
      if (!intent) fail("not_found");
      const target = "result" in p ? p.result : p;
      if (target.taskId !== intent.taskId || target.intentId !== intent.id) fail("conflict");
      if ("taskId" in p && p.taskId !== intent.taskId) fail("conflict");
      if ("intentId" in p && (p.intentId !== intent.id || p.operationId !== intent.operationId)) fail("conflict");
      checkFence(intent, command);
      if (ctx.scope.actor.instanceId !== intent.homeInstanceId) fail("wrong_home");
      if (command.type === "operation.result") return recordResult(ctx, ports, command, intent);
      const rows = currentRows(ctx, ports, intent.taskId, command.type === "intent.check");
      assertVersion(rows, command.payload);
      if (command.type === "operation.reconcile") return reconcile(ctx, ports, command, intent, rows);
      if (command.type === "intent.cancel") return cancel(ctx, ports, command, intent, rows);
      return check(ctx, ports, command, intent, rows);
    },
  };
}
function event(ctx: V2TransactionContext, ports: IntentPorts, command: IntentCommand, intent: V2Intent): number {
  const draft = { teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, timestamp: ctx.scope.now,
    entityId: intent.id, kind: command.type.startsWith("operation.") ? "operation" as const : "intent" as const,
    command: command.type, requestId: command.requestId, actor: ctx.scope.actor, summary: intent.reason,
    taskRev: intent.taskRev, specRev: intent.specRev, head: intent.head, source: null };
  const seq = ports.appendEvent(ctx, draft);
  parseEvent({ ...draft, seq });
  return seq;
}
function create(ctx: V2TransactionContext, ports: IntentPorts, command: Extract<IntentCommand, { type: "intent.create" }>): IntentOutcome {
  const p = command.payload, fingerprint = v2ObjectDigest({ payload: p, epoch: command.epoch,
    serviceGeneration: command.serviceGeneration, bootId: command.bootId });
  const old = getIntent(ctx, p.operationId);
  if (old) {
    if (old.fingerprint !== fingerprint) fail("dedup_mismatch");
    return { intent: old.intent, result: getResult(ctx, p.operationId) };
  }
  const rows = currentRows(ctx, ports, p.taskId, true);
  assertVersion(rows, p); assertDependencies(rows, p.dependencyDigest);
  if (p.head !== rows.task.head || p.round !== rows.task.round) fail("conflict");
  assertAuthorization(ctx, ports, rows, p, p.authorizationAskId, p.authorizationDigest);
  const occupied = getResources(ctx);
  if (p.resources.some(key => occupied.some(r => resourcesOverlap(key, r.key)))) fail("resource_busy");
  let intent = parseIntent({ teamId: command.teamId, projectId: command.projectId, id: p.operationId,
    taskId: p.taskId, homeInstanceId: rows.task.homeInstanceId, executorInstanceId: rows.task.executorInstanceId,
    serviceGeneration: command.serviceGeneration, epoch: command.epoch, bootId: command.bootId,
    node: p.node, action: p.action, operationId: p.operationId, taskRev: p.expectedRev, specRev: p.expectedSpecRev,
    workflowRev: p.expectedWorkflowRev, templateVersion: rows.workflow.templateVersion, head: p.head, round: p.round,
    dependencyDigest: p.dependencyDigest, authorizationAskId: p.authorizationAskId, authorizationDigest: p.authorizationDigest,
    resources: p.resources, causalSeq: 0, eventSeq: 1, status: "pending", attempts: 0, reason: "",
    createdAt: ctx.scope.now, updatedAt: ctx.scope.now });
  // Overlapping repository/file keys within one intent add no coverage and are refused to avoid aliases.
  if (intent.resources.some((r, i) => intent.resources.slice(i + 1).some(other => resourcesOverlap(r, other)))) fail();
  intent = parseIntent({ ...intent, eventSeq: event(ctx, ports, command, intent) });
  ctx.run("intents.insert", { operationId: intent.operationId, id: intent.id, fingerprint, body: JSON.stringify(intent) });
  holdResources(ctx, intent);
  return { intent, result: null };
}
function check(
  ctx: V2TransactionContext, ports: IntentPorts, command: Extract<IntentCommand, { type: "intent.check" }>,
  intent: V2Intent, rows: IntentCurrent,
): IntentOutcome {
  if (intent.status !== "pending") fail("unknown_operation");
  if (intent.taskRev !== rows.task.rev || intent.specRev !== rows.task.specRev || intent.workflowRev !== rows.workflow.rev
    || intent.head !== rows.task.head || intent.round !== rows.task.round) fail("conflict");
  const p = command.payload;
  if (p.authorizationAskId !== intent.authorizationAskId || p.authorizationDigest !== intent.authorizationDigest) fail("authorization_mismatch");
  assertDependencies(rows, intent.dependencyDigest);
  assertAuthorization(ctx, ports, rows, intent, p.authorizationAskId, p.authorizationDigest);
  const held = getResources(ctx).filter(r => r.operationId === intent.operationId);
  if (held.length !== intent.resources.length || held.some(r => r.state !== "held")) fail("resource_busy");
  const next = { ...intent, status: "submitted" as const, attempts: 1, updatedAt: ctx.scope.now };
  saveIntent(ctx, next); event(ctx, ports, command, next);
  return { intent: next, result: null };
}
function recordResult(
  ctx: V2TransactionContext, ports: IntentPorts, command: Extract<IntentCommand, { type: "operation.result" }>, intent: V2Intent,
): IntentOutcome {
  const supplied = command.payload.result;
  const previous = getResult(ctx, intent.operationId);
  if (previous) return { intent, result: previous };
  // Expiry stops new effects, not an observation of an already-started effect under the same fence.
  currentRows(ctx, ports, intent.taskId, false);
  if (intent.status === "unknown") fail("unknown_operation");
  if (intent.status !== "submitted") fail("conflict");
  if (supplied.approvalAskId !== intent.authorizationAskId || supplied.observedAt < intent.createdAt
    || supplied.observedAt > ctx.scope.now) fail("conflict");
  return finish(ctx, ports, command, intent, supplied, false);
}
function finish(
  ctx: V2TransactionContext, ports: IntentPorts, command: IntentCommand, intent: V2Intent, result: V2OperationResult, reconcile: boolean,
): IntentOutcome {
  const unknown = result.state === "unknown";
  // Frozen intent DTO has no failed state: done means settled; the receipt preserves succeeded versus failed.
  const next = { ...intent, status: unknown ? "unknown" as const : "done" as const, reason: result.summary.slice(0, 2000), updatedAt: ctx.scope.now };
  ctx.run(reconcile ? "intents.result.reconcile" : "intents.result.insert", { operationId: intent.operationId, body: JSON.stringify(result) });
  saveIntent(ctx, next);
  if (unknown) markUnknown(ctx, next); else ctx.run("intents.free", { operationId: intent.operationId });
  event(ctx, ports, command, next);
  return { intent: next, result };
}
function reconcile(
  ctx: V2TransactionContext, ports: IntentPorts, command: Extract<IntentCommand, { type: "operation.reconcile" }>,
  intent: V2Intent, rows: IntentCurrent,
): IntentOutcome {
  const p = command.payload, previous = getResult(ctx, intent.operationId);
  assertReconciliation(ctx, ports, rows, p.authorizationAskId);
  if (previous && previous.state !== "unknown") return { intent, result: previous };
  if (!["unknown", "submitted"].includes(intent.status) || p.result.state === "unknown") fail("unknown_operation");
  if (p.intentId !== intent.id || p.operationId !== intent.operationId || p.result.approvalAskId !== p.authorizationAskId
    || p.result.observedAt < intent.createdAt || p.result.observedAt > ctx.scope.now) fail("conflict");
  return finish(ctx, ports, command, intent, p.result, previous !== null);
}
function cancel(
  ctx: V2TransactionContext, ports: IntentPorts, command: Extract<IntentCommand, { type: "intent.cancel" }>,
  intent: V2Intent, rows: IntentCurrent,
): IntentOutcome {
  if (intent.status === "cancelled") return { intent, result: getResult(ctx, intent.operationId) };
  if (intent.status === "done") fail("conflict");
  // Cancelling a possibly started effect is an explicit owner reconciliation, never a timeout cleanup.
  assertReconciliation(ctx, ports, rows);
  const result = parseOperationResult({ teamId: intent.teamId, projectId: intent.projectId, operationId: intent.operationId,
    intentId: intent.id, taskId: intent.taskId, epoch: intent.epoch, bootId: intent.bootId, serviceGeneration: intent.serviceGeneration,
    state: "failed", head: intent.head, approvalAskId: intent.authorizationAskId, summary: command.payload.reason,
    artifactIds: [], observedAt: ctx.scope.now });
  const next = { ...intent, status: "cancelled" as const, reason: command.payload.reason, updatedAt: ctx.scope.now };
  ctx.run(getResult(ctx, intent.operationId) ? "intents.result.reconcile" : "intents.result.insert",
    { operationId: intent.operationId, body: JSON.stringify(result) });
  saveIntent(ctx, next); ctx.run("intents.free", { operationId: intent.operationId }); event(ctx, ports, command, next);
  return { intent: next, result };
}
