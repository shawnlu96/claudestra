import {
  assertFence, fail, parseFeature, parseTask, parseWorkflow, parseDag, parseEvent, v2ObjectDigest,
  type V2Fence, type V2Command, type V2Feature, type V2Task, type V2Workflow, type V2Event, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";

export type AskCommand = Extract<V2Command, { type:
  "ask.create" | "ask.answer" | "ask.cancel" | "ask.expire" | "authorization.check" | "dag.propose" | "dag.decide" }>;
export type Dag = ReturnType<typeof parseDag>;
/** All ports are synchronous and use the supplied caller transaction, never cached/request rows. */
export interface AskPorts {
  authorize(ctx: V2TransactionContext, command: AskCommand): void;
  isOwner(ctx: V2TransactionContext, personId: string): boolean;
  readFeature(ctx: V2TransactionContext, featureId: string): V2Feature;
  readTask(ctx: V2TransactionContext, taskId: string): V2Task;
  readWorkflow(ctx: V2TransactionContext, taskId: string): V2Workflow;
  readDag(ctx: V2TransactionContext, featureId: string): Dag;
  /** Complete current feature task set, including unbound tasks affected by cancellation. */
  readTasks(ctx: V2TransactionContext, featureId: string): V2Task[];
  /** X14 validates completed-node inheritance and applies graph/cancellations/CAS atomically. */
  replaceDag(ctx: V2TransactionContext, feature: V2Feature, dag: Dag, cancels: string[]): void;
  appendEvent(ctx: V2TransactionContext, event: Omit<V2Event, "seq">): number;
}
export function checkScope(ctx: V2TransactionContext, row: { teamId: string; projectId: string }): void {
  if (row.teamId !== ctx.scope.teamId || row.projectId !== ctx.scope.projectId) fail("forbidden");
}
export function gate(ctx: V2TransactionContext, ports: AskPorts, command: AskCommand): void {
  checkScope(ctx, command);
  const fence = ({ serviceGeneration, epoch, bootId }: V2Fence) => ({ serviceGeneration, epoch, bootId });
  assertFence(fence(ctx.scope), fence(command));
  if (!ctx.scope.actor.actions.includes(command.type)) fail("forbidden");
  if (ports.authorize(ctx, command) !== undefined) fail("transaction_control");
}
export function owner(ctx: V2TransactionContext, ports: AskPorts): void {
  if (ctx.scope.actor.kind !== "person" || ports.isOwner(ctx, ctx.scope.actor.personId) !== true) fail("forbidden");
}
export function feature(ctx: V2TransactionContext, ports: AskPorts, id: string): V2Feature {
  const row = parseFeature(ports.readFeature(ctx, id)); checkScope(ctx, row);
  if (row.id !== id) fail("not_found");
  if (row.authorityMode === "source") fail("execution_not_shared");
  if (row.epoch !== ctx.scope.epoch) fail("stale_epoch");
  return row;
}
export function task(ctx: V2TransactionContext, ports: AskPorts, id: string, featureId: string): V2Task {
  const row = parseTask(ports.readTask(ctx, id)); checkScope(ctx, row);
  if (row.id !== id || row.featureId !== featureId) fail("conflict");
  return row;
}
export function workflow(ctx: V2TransactionContext, ports: AskPorts, row: V2Task): V2Workflow {
  const wf = parseWorkflow(ports.readWorkflow(ctx, row.id)); checkScope(ctx, wf);
  if (wf.taskId !== row.id || wf.specRev !== row.specRev) fail("conflict");
  return wf;
}
export function event(ctx: V2TransactionContext, ports: AskPorts, command: AskCommand, entityId: string, kind: "ask" | "dag", summary: string): number {
  const draft = { teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, entityId, kind,
    command: command.type, requestId: command.requestId, actor: ctx.scope.actor, timestamp: ctx.scope.now,
    summary, taskRev: null, specRev: null, head: null, source: null };
  const seq = ports.appendEvent(ctx, draft); parseEvent({ ...draft, seq }); return seq;
}
export function entityId(ctx: V2TransactionContext, command: AskCommand, kind: string): string {
  return v2ObjectDigest({ teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, actor: ctx.scope.actor, requestId: command.requestId, kind });
}
