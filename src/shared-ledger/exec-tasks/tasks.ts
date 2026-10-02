import { canTransition, nextTaskState } from "../../lib/ledger-stages.js";
import {
  fail, parseTask, type V2Task, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { featureGate, taskGate, resultGate, authorizeTask, type TaskCommand, type TasksDependencies } from "./policy.js";
import { readItem, readTask, saveRow } from "./storage.js";

function newTask(ctx: V2TransactionContext, deps: TasksDependencies, command: Extract<TaskCommand, { type: "task.new" }>, id: string): V2Task {
  const p = command.payload, feature = featureGate(ctx, deps, p.featureId);
  if (feature.rev !== p.expectedRev) fail("conflict");
  if (p.itemId !== null) {
    const item = readItem(ctx, p.itemId);
    if (item.featureId !== null && item.featureId !== p.featureId) fail("conflict");
  }
  const { teamId, projectId, now } = ctx.scope;
  const task = parseTask({ teamId, projectId, id, itemId: p.itemId, featureId: p.featureId, title: p.title,
    plan: p.plan, kind: p.kind, stage: "spec", stageBefore: null, round: 0, specRev: 1, rev: 1,
    createdAt: now, updatedAt: now, homeInstanceId: feature.homeInstanceId, executor: null, executorInstanceId: null,
    pm: null, repository: p.repository, branch: null, pr: null, head: null, spec: p.spec,
    collaboration: { reviewer: null, delegate: null }, review: { verdict: null, reviewedHead: null, reportArtifactId: null },
    delivery: { orderId: null, summary: "", artifactIds: [] } });
  authorizeTask(ctx, deps, command, task);
  return saveRow(ctx, "tasks", task) as V2Task;
}
export function applyTask(ctx: V2TransactionContext, deps: TasksDependencies, command: TaskCommand, newId: string): V2Task {
  if (command.type === "task.new") return newTask(ctx, deps, command, newId);
  const current = readTask(ctx, command.payload.taskId);
  taskGate(ctx, deps, command, current);
  const task = { ...current, rev: current.rev + 1, updatedAt: ctx.scope.now };
  switch (command.type) {
    case "task.set": Object.assign(task, command.payload.patch); break;
    case "task.spec":
      task.spec = command.payload.spec; task.specRev = command.payload.nextSpecRev;
      task.review = { verdict: null, reviewedHead: null, reportArtifactId: null };
      break;
    case "task.assign":
      task.executor = command.payload.executor;
      task.executorInstanceId = task.executor.kind === "human" ? null : task.executor.instanceId;
      break;
    case "task.stage": {
      const p = command.payload;
      if (current.stage !== p.from || current.round !== p.round) fail("conflict");
      // Role/owner authorization was independently checked; reuse the canonical legal transition graph.
      if (!canTransition(current, p.to, "owner").ok) fail("conflict");
      Object.assign(task, nextTaskState(current, p.to));
      break;
    }
    case "task.deliver":
      resultGate(ctx, deps, command, current);
      task.head = command.payload.head;
      task.delivery = { orderId: command.payload.orderId, summary: command.payload.summary, artifactIds: command.payload.artifactIds };
      task.review = { verdict: null, reviewedHead: null, reportArtifactId: null };
      break;
    case "task.review":
      resultGate(ctx, deps, command, current);
      task.review = { verdict: command.payload.verdict, reviewedHead: command.payload.head, reportArtifactId: command.payload.reportArtifactId };
      break;
  }
  return saveRow(ctx, "tasks", task, current.rev) as V2Task;
}
