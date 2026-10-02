import {
  assertFence, fail, parseFeature, parseTask,
  type V2Command, type V2Feature, type V2Fence, type V2Task, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { checkScope } from "./storage.js";

export type WorkflowCommand = Extract<V2Command, { type: "workflow.set" | "step.assign" }>;
export type DagCommand = Extract<V2Command, { type: "dag.init" | "dag.rewrite" | "dag.bind" }>;
export type WorkflowsCommand = WorkflowCommand | DagCommand;
export const WORKFLOW_COMMANDS: readonly WorkflowsCommand["type"][] = ["workflow.set", "step.assign", "dag.init", "dag.rewrite", "dag.bind"];
/** Trusted composition-root callbacks; readers and writers must use the given context (one caller transaction). */
export interface WorkflowsDependencies {
  /** Membership, person/instance binding, command role, scoped service actions, generation and capability gates. */
  authorize(ctx: V2TransactionContext, command: V2Command): void;
  /** Per-action checks: owner for workflow.set (and the live auto-mode ask bind), executor eligibility for step.assign,
   * planning rights for DAG commands. Runs on receipt retries too. */
  authorizeWorkflow(ctx: V2TransactionContext, command: WorkflowsCommand, task: V2Task | null): void;
  feature(ctx: V2TransactionContext, id: string): V2Feature;
  /** Single-row CAS write of the feature (rev must equal expectedRev + 1); must throw on zero rows. */
  saveFeature(ctx: V2TransactionContext, next: V2Feature, expectedRev: number): void;
  task(ctx: V2TransactionContext, id: string): V2Task;
  /** X1 task row CAS write in the same transaction; must throw on zero rows. */
  saveTask(ctx: V2TransactionContext, next: V2Task, expectedRev: number): void;
}
export function commandGate(ctx: V2TransactionContext, command: V2Command, deps: WorkflowsDependencies): void {
  checkScope(ctx, command);
  const pick = ({ serviceGeneration, epoch, bootId }: V2Fence) => ({ serviceGeneration, epoch, bootId });
  assertFence(pick(ctx.scope), pick(command));
  if (!ctx.scope.actor.actions.includes(command.type)) fail("forbidden");
  // Order-scoped worker identities report through lend.result; they never steer workflow, steps or the DAG.
  if (ctx.scope.actor.orderId !== null) fail("forbidden");
  if (deps.authorize(ctx, command) !== undefined) fail("transaction_control");
}
/** V2 only owns execution-mode features; planning stays with the V1 service so there is never dual authority. */
export function featureGate(ctx: V2TransactionContext, deps: WorkflowsDependencies, featureId: string): V2Feature {
  const f = parseFeature(deps.feature(ctx, featureId));
  checkScope(ctx, f);
  if (f.id !== featureId) return fail("not_found");
  if (f.authorityMode === "execution") return f.epoch === ctx.scope.epoch ? f : fail("stale_epoch");
  return fail("execution_not_shared");
}
export function loadTask(ctx: V2TransactionContext, deps: WorkflowsDependencies, taskId: string): V2Task {
  const task = parseTask(deps.task(ctx, taskId));
  checkScope(ctx, task);
  if (task.id !== taskId) fail("not_found");
  return task;
}
export function authorizeWorkflow(ctx: V2TransactionContext, deps: WorkflowsDependencies, command: WorkflowsCommand, task: V2Task | null): void {
  if (deps.authorizeWorkflow(ctx, command, task) !== undefined) fail("transaction_control");
}
export function nextFeature(ctx: V2TransactionContext, feature: V2Feature, patch: Partial<V2Feature> = {}): V2Feature {
  return parseFeature({ ...feature, ...patch, rev: feature.rev + 1, updatedAt: ctx.scope.now });
}
