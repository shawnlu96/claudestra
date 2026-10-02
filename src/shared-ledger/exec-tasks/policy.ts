import {
  assertFence, fail, parseFeature, parseWorkflow, parseLendOrder, parseLendResult, v2ObjectDigest,
  type V2Fence, type V2Task, type V2Command, type V2Feature, type V2Workflow, type V2LendOrder, type V2LendResult, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { checkScope } from "./storage.js";

export type TaskCommand = Extract<V2Command, { type: "task.new" | "task.set" | "task.spec" | "task.assign" | "task.stage" | "task.deliver" | "task.review" }>;
export type TasksCommand = TaskCommand | Extract<V2Command, { type: "item.new" | "item.set" | "dep.set" | "dep.remove" }>;
export type ResultCommand = Extract<V2Command, { type: "task.deliver" | "task.review" }>;
/** Trusted composition-root readers must query the same context, never a cache or another transaction. */
export interface TasksDependencies {
  authorize(ctx: V2TransactionContext, command: V2Command): void;
  authorizeTask(ctx: V2TransactionContext, command: TaskCommand, task: V2Task): void;
  feature(ctx: V2TransactionContext, id: string): V2Feature;
  workflow(ctx: V2TransactionContext, taskId: string): V2Workflow;
  // Returns the current order for this task/step, even when the command tries to omit its orderId.
  order(ctx: V2TransactionContext, task: V2Task, command: ResultCommand): V2LendOrder | null;
  result(ctx: V2TransactionContext, orderId: string): V2LendResult;
}
export function commandGate(ctx: V2TransactionContext, command: V2Command, deps: TasksDependencies): void {
  checkScope(ctx, command);
  checkFence(ctx, command);
  if (!ctx.scope.actor.actions.includes(command.type)) fail("forbidden");
  if (deps.authorize(ctx, command) !== undefined) fail("transaction_control");
}
export function featureGate(ctx: V2TransactionContext, deps: TasksDependencies, featureId: string): V2Feature {
  const feature = parseFeature(deps.feature(ctx, featureId));
  checkScope(ctx, feature);
  if (feature.id !== featureId) fail("not_found");
  if (feature.authorityMode !== "execution") fail("execution_not_shared");
  if (feature.epoch !== ctx.scope.epoch) fail("stale_epoch");
  return feature;
}
export function taskGate(ctx: V2TransactionContext, deps: TasksDependencies, command: TaskCommand, task: V2Task): void {
  const f = featureGate(ctx, deps, task.featureId);
  if (task.homeInstanceId !== f.homeInstanceId) fail("wrong_home");
  if (command.type === "task.new") fail();
  if (task.rev !== command.payload.expectedRev || task.specRev !== command.payload.expectedSpecRev) fail("conflict");
  if ("expectedWorkflowRev" in command.payload) {
    const wf = parseWorkflow(deps.workflow(ctx, task.id));
    checkScope(ctx, wf);
    if (wf.taskId !== task.id || wf.rev !== command.payload.expectedWorkflowRev || wf.specRev !== task.specRev) fail("conflict");
    if (ctx.scope.actor.instanceId !== task.homeInstanceId) fail("wrong_home");
    // Workers submit lend.result; an order-scoped identity cannot mutate the whole card.
    if (ctx.scope.actor.orderId !== null) fail("forbidden");
  }
  authorizeTask(ctx, deps, command, task);
}
export function authorizeTask(ctx: V2TransactionContext, deps: TasksDependencies, command: TaskCommand, task: V2Task): void {
  if (deps.authorizeTask(ctx, command, task) !== undefined) fail("transaction_control");
}
export function resultGate(ctx: V2TransactionContext, deps: TasksDependencies, command: ResultCommand, task: V2Task): void {
  const p = command.payload;
  if (p.round !== task.round) fail("conflict");
  if (command.type === "task.review" && (task.stage !== "review" || task.head !== p.head)) fail("conflict");
  if (command.type === "task.deliver" && !["build", "fix"].includes(task.stage)) fail("conflict");
  const raw = deps.order(ctx, task, command);
  if (!raw) { if (p.orderId !== null) fail("stale_order"); return; }
  const order = parseLendOrder(raw);
  checkScope(ctx, order); checkFence(ctx, order);
  if (order.orderId !== p.orderId || order.taskId !== task.id || order.featureId !== task.featureId
    || order.homeInstanceId !== task.homeInstanceId || order.specRev !== task.specRev || order.round !== p.round
    || order.head !== task.head || order.status !== "done"
    || order.step !== (command.type === "task.review" ? "review" : task.stage === "fix" ? "fix" : "write")) fail("stale_order");
  if (order.leaseGen !== p.leaseGen) fail("stale_lease_gen");
  const result = parseLendResult(deps.result(ctx, order.orderId));
  checkScope(ctx, result); checkFence(ctx, result);
  if (result.orderId !== order.orderId || result.taskId !== task.id || result.specRev !== task.specRev
    || result.round !== p.round || result.expectedHead !== task.head || result.head !== p.head
    || result.executorInstanceId !== order.executorInstanceId || result.operationId !== order.resultOperationId
    || result.resultDigest !== order.resultDigest || v2ObjectDigest(result.worker) !== v2ObjectDigest(order.worker)) fail("stale_order");
  if (result.leaseGen !== p.leaseGen) fail("stale_lease_gen");
  if (command.type === "task.deliver") {
    if (result.verdict !== "delivered" || result.summary !== command.payload.summary
      || JSON.stringify(result.artifactIds) !== JSON.stringify(command.payload.artifactIds)) fail("conflict");
  } else if (result.verdict !== command.payload.verdict || !result.artifactIds.includes(command.payload.reportArtifactId)) fail("conflict");
}
function checkFence(ctx: V2TransactionContext, value: V2Fence): void {
  const pick = ({ serviceGeneration, epoch, bootId }: V2Fence) => ({ serviceGeneration, epoch, bootId });
  assertFence(pick(ctx.scope), pick(value));
}
