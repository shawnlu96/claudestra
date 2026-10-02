import {
  assertFence, fail, parseTask, parseFeature, parseWorkflow, parseLease, parseDependency, parseAsk, parseAuthorizationBind, v2ObjectDigest,
  type V2AuthorizationBind, type V2Fence, type V2Task, type V2Feature, type V2Workflow, type V2Lease, type V2Dependency, type V2Ask,
  type V2TransactionContext, type V2Event, type V2Intent, type V2Command,
} from "../../lib/shared-ledger-contract-v2.js";

export interface IntentCurrent {
  task: V2Task; feature: V2Feature; workflow: V2Workflow; lease: V2Lease; dependencies: V2Dependency[];
}
/** X12 adapts sibling domains through these synchronous, caller-transaction ports.
 * Reads must query current central rows via the supplied context, never caches or request DTOs.
 * appendEvent allocates the shared serverSeq and writes the event in that same transaction.
 */
export interface IntentPorts {
  readCurrent(ctx: V2TransactionContext, taskId: string): IntentCurrent;
  readAsk(ctx: V2TransactionContext, askId: string): V2Ask;
  isOwner(ctx: V2TransactionContext, personId: string): boolean;
  appendEvent(ctx: V2TransactionContext, event: Omit<V2Event, "seq">): number;
}
export type IntentCommand = Extract<V2Command, { type:
  "intent.create" | "intent.check" | "intent.cancel" | "operation.result" | "operation.reconcile" }>;
export type ExecutionVersion = { taskId: string; expectedRev: number; expectedSpecRev: number; expectedWorkflowRev: number };
export function assertScope(ctx: V2TransactionContext, value: { teamId: string; projectId: string }): void {
  if (value.teamId !== ctx.scope.teamId || value.projectId !== ctx.scope.projectId) fail("forbidden");
}
export function currentRows(ctx: V2TransactionContext, ports: IntentPorts, taskId: string, live: boolean): IntentCurrent {
  const rows = ports.readCurrent(ctx, taskId);
  const task = parseTask(rows.task), feature = parseFeature(rows.feature), workflow = parseWorkflow(rows.workflow), lease = parseLease(rows.lease);
  const dependencies = rows.dependencies.map(parseDependency);
  for (const row of [task, feature, workflow, lease, ...dependencies]) assertScope(ctx, row);
  if (task.id !== taskId || feature.id !== task.featureId || workflow.taskId !== taskId || lease.taskId !== taskId) fail("conflict");
  if (feature.authorityMode !== "execution") fail("execution_not_shared");
  if (task.homeInstanceId !== feature.homeInstanceId || lease.homeInstanceId !== task.homeInstanceId
    || ctx.scope.actor.instanceId !== task.homeInstanceId) fail("wrong_home");
  checkFence(ctx.scope, lease);
  if (feature.epoch !== lease.epoch) fail("stale_epoch");
  if (live && lease.expiresAt <= ctx.scope.now) fail("lease_expired");
  if (dependencies.some(d => d.toTask !== taskId)) fail("conflict");
  return { task, feature, workflow, lease, dependencies };
}
export function assertVersion(rows: IntentCurrent, expected: ExecutionVersion): void {
  if (rows.task.rev !== expected.expectedRev || rows.task.specRev !== expected.expectedSpecRev
    || rows.workflow.rev !== expected.expectedWorkflowRev || rows.workflow.specRev !== rows.task.specRev) fail("conflict");
}
export function assertDependencies(rows: IntentCurrent, digest: string): void {
  if (rows.dependencies.some(d => d.state !== "done")) fail("dependency_blocked");
  // Sort the complete incoming dependency DTO set so order cannot change its content binding.
  const actual = v2ObjectDigest([...rows.dependencies].sort((a, b) => a.fromTask < b.fromTask ? -1 : a.fromTask > b.fromTask ? 1 : 0));
  if (actual !== digest) fail("dependency_blocked");
}
function approvedAsk(ctx: V2TransactionContext, ports: IntentPorts, askId: string): V2Ask {
  const ask = parseAsk(ports.readAsk(ctx, askId));
  assertScope(ctx, ask);
  if (ask.id !== askId || ask.state !== "answered" || ask.decision !== "approved" || !ask.bind
    || !ask.answeredBy || !ports.isOwner(ctx, ask.answeredBy)) fail("authorization_mismatch");
  if (ask.expiresAt <= ctx.scope.now) fail("authorization_expired");
  return ask;
}
export function assertAuthorization(
  ctx: V2TransactionContext, ports: IntentPorts, rows: IntentCurrent,
  target: Pick<V2Intent, "action" | "node" | "head" | "round" | "resources">, askId: string | null, digest: string | null,
): void {
  const { action } = target;
  if (askId === null) {
    if (digest !== null || ["merge", "deploy", "release"].includes(action) || rows.workflow.mode === "auto") fail("authorization_mismatch");
    return;
  }
  const ask = approvedAsk(ctx, ports, askId), bind = ask.bind!;
  const required = ["merge", "deploy", "release"].includes(action) ? action : "workflow.auto";
  if (bind.actionDigest !== intentActionDigest(target) || digest !== intentAuthorizationDigest(bind) || !bind.actions.some(a => a === required)
    || bind.taskId !== rows.task.id || bind.featureId !== rows.feature.id || bind.taskRev !== rows.task.rev
    || bind.specRev !== rows.task.specRev || bind.workflowRev !== rows.workflow.rev
    || bind.baseVersion !== rows.feature.currentVersion || bind.homeInstanceId !== rows.task.homeInstanceId
    || bind.head !== rows.task.head || bind.originalDigest !== rows.task.spec.originalDigest
    || bind.sharedDigest !== rows.task.spec.sharedDigest) fail("authorization_mismatch");
}
export function assertReconciliation(ctx: V2TransactionContext, ports: IntentPorts, rows: IntentCurrent, askId?: string): void {
  if (ctx.scope.actor.kind !== "person" || !ports.isOwner(ctx, ctx.scope.actor.personId)) fail("forbidden");
  if (askId !== undefined) {
    const ask = approvedAsk(ctx, ports, askId), bind = ask.bind!;
    if (bind.taskId !== rows.task.id || bind.featureId !== rows.feature.id || bind.taskRev !== rows.task.rev
      || bind.specRev !== rows.task.specRev || bind.workflowRev !== rows.workflow.rev
      || bind.homeInstanceId !== rows.task.homeInstanceId) fail("authorization_mismatch");
  }
}

export function checkFence(expected: V2Fence, supplied: V2Fence): void {
  const fields = (f: V2Fence) => ({ serviceGeneration: f.serviceGeneration, epoch: f.epoch, bootId: f.bootId });
  assertFence(fields(expected), fields(supplied));
}

/** Bind the executable action coordinates, independent of request IDs and generated operation IDs. */
export function intentActionDigest(target: Pick<V2Intent, "action" | "node" | "head" | "round" | "resources">): string {
  return v2ObjectDigest({ action: target.action, node: target.node, head: target.head, round: target.round, resources: target.resources });
}

export function intentAuthorizationDigest(bind: V2AuthorizationBind): string {
  return v2ObjectDigest(parseAuthorizationBind(bind));
}
