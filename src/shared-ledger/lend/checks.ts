import type { V2Command } from "../../lib/shared-ledger-contract-v2-commands.js";
import { parseFeature, type V2Feature } from "../../lib/shared-ledger-contract-v2-dag.js";
import type { V2LendOrder } from "../../lib/shared-ledger-contract-v2-lend.js";
import { parseStep, parseTask, parseWorkflow, type V2Executor, type V2Step, type V2Task, type V2Workflow } from "../../lib/shared-ledger-contract-v2-tasks.js";
import type { V2MigrationManifest } from "../../lib/shared-ledger-contract-v2-transfer.js";
import { assertTransactionContext, type V2TransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { assertFence, v2ObjectDigest } from "../../lib/shared-ledger-contract-v2-integrity.js";
import { fail, type V2Fence } from "../../lib/shared-ledger-contract-v2-validation.js";

export type LendCommand = Extract<V2Command, { type: `lend.${string}` }>;
export interface LendExecution { task: V2Task; workflow: V2Workflow; feature: V2Feature }
/** Required X12 adapters run synchronously in this SAME context. No process, network, local ledger or commit hooks.
 * authorize checks live scheduler lease, registered home/service action, artifact and machine-owner grant/bind.
 * authorizeImport checks owner approval, source write gate, manifest receipt and reconciled imported leases.
 */
export interface LendPorts {
  loadExecution(context: V2TransactionContext, taskId: string): LendExecution;
  authorize(context: V2TransactionContext, command: LendCommand, order: V2LendOrder | null): void;
  authorizeImport(context: V2TransactionContext, manifest: V2MigrationManifest): void;
  readStep(context: V2TransactionContext, order: V2LendOrder): V2Step | null;
  writeStep(context: V2TransactionContext, previous: V2Step | null, next: V2Step): void;
  /** Allocate the central event sequence and append the event; X12 adds the immutable command receipt. */
  appendEvent(context: V2TransactionContext, command: LendCommand, order: V2LendOrder): number;
}
export function synchronous(value: unknown): void {
  if (value && typeof (value as { then?: unknown }).then === "function") fail("transaction_control");
}
export function assertScope(context: V2TransactionContext, row: { teamId: string; projectId: string }): void {
  assertTransactionContext(context);
  if (row.teamId !== context.scope.teamId || row.projectId !== context.scope.projectId) fail("forbidden");
}
export function assertCommand(context: V2TransactionContext, command: LendCommand): void {
  assertScope(context, command); assertFence(fenceOf(context.scope), fenceOf(command));
  if (!context.scope.actor.actions.includes(command.type)) fail("forbidden");
}
export function loadExecution(context: V2TransactionContext, ports: LendPorts, taskId: string): LendExecution {
  const raw = ports.loadExecution(context, taskId);
  const task = parseTask(raw.task), workflow = parseWorkflow(raw.workflow), feature = parseFeature(raw.feature);
  for (const row of [task, workflow, feature]) assertScope(context, row);
  if (task.id !== taskId || workflow.taskId !== task.id || task.featureId !== feature.id) fail("stale_order");
  if (feature.authorityMode !== "execution") fail("execution_not_shared");
  if (feature.status !== "active") fail("conflict");
  if (feature.homeInstanceId !== task.homeInstanceId || context.scope.actor.instanceId !== task.homeInstanceId) fail("wrong_home");
  if (feature.epoch !== context.scope.epoch) fail("stale_epoch");
  return { task, workflow, feature };
}
export const sameWorker = (a: V2Executor | null, b: V2Executor | null): boolean => v2ObjectDigest(a) === v2ObjectDigest(b);
export const stageFor = { review: "review", write: "build", fix: "fix" } as const;
export function assertTaskOrder(task: V2Task, order: V2LendOrder): void {
  if (task.id !== order.taskId || task.featureId !== order.featureId || task.homeInstanceId !== order.homeInstanceId
    || task.specRev !== order.specRev || task.round !== order.round
    || (task.head !== order.head && !(order.step === "write" && task.head === null))
    || task.repository !== order.repository || task.stage !== stageFor[order.step]) fail("stale_order");
}
export function assertOrderContext(context: V2TransactionContext, order: V2LendOrder): void {
  assertScope(context, order); assertFence(fenceOf(context.scope), fenceOf(order));
  const actorOrder = context.scope.actor.orderId;
  if (actorOrder !== null && actorOrder !== order.orderId) fail("forbidden");
}
export function assertVersions(execution: LendExecution, version: { expectedRev: number; expectedSpecRev: number; expectedWorkflowRev: number }): void {
  if (execution.task.rev !== version.expectedRev || execution.task.specRev !== version.expectedSpecRev
    || execution.workflow.rev !== version.expectedWorkflowRev || execution.workflow.specRev !== version.expectedSpecRev) fail("conflict");
}
export function assertLiveLease(context: V2TransactionContext, order: V2LendOrder, leaseGen: number, executorInstanceId: string): void {
  if (leaseGen !== order.leaseGen) fail("stale_lease_gen");
  if (executorInstanceId !== order.executorInstanceId) fail("forbidden");
  if (order.status !== "claimed") fail("stale_order");
  if (order.leaseUntil === null || order.leaseUntil <= context.scope.now) fail("lease_expired");
}
export function orderStep(context: V2TransactionContext, ports: LendPorts, order: V2LendOrder): V2Step | null {
  const raw = ports.readStep(context, order);
  if (!raw) return null;
  const step = parseStep(raw); assertScope(context, step);
  if (step.taskId !== order.taskId || step.step !== order.step || step.round !== order.round) fail("stale_order");
  return step;
}
export function fenceOf(f: V2Fence): V2Fence {
  return { serviceGeneration: f.serviceGeneration, epoch: f.epoch, bootId: f.bootId };
}
