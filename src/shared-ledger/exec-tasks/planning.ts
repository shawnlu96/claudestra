import { findPath } from "../../lib/ledger-deps.js";
import {
  fail, parseItem, parseDependency, type V2Command, type V2TransactionContext, type V2Item, type V2Dependency,
} from "../../lib/shared-ledger-contract-v2.js";
import { featureGate, type TasksDependencies } from "./policy.js";
import { dependencies, dependencyId, readItem, readTask, saveRow, saveVersion } from "./storage.js";

type ItemCommand = Extract<V2Command, { type: "item.new" | "item.set" }>;
type DepCommand = Extract<V2Command, { type: "dep.set" | "dep.remove" }>;
export function applyItem(ctx: V2TransactionContext, deps: TasksDependencies, command: ItemCommand, id: string): V2Item {
  const { teamId, projectId, now, actor } = ctx.scope;
  if (command.type === "item.new") {
    const p = command.payload;
    if (p.featureId !== null) featureGate(ctx, deps, p.featureId);
    const item = parseItem({ teamId, projectId, id, featureId: p.featureId, title: p.title,
      ownerWords: "", ownerWordsBy: actor.personId, description: p.description, descriptionBy: actor.personId,
      priority: "", status: "todo", oneLine: "", next: "", rev: 1, createdAt: now, updatedAt: now });
    return saveRow(ctx, "items", item) as V2Item;
  }
  const p = command.payload, current = readItem(ctx, p.itemId);
  if (current.featureId !== null) featureGate(ctx, deps, current.featureId);
  if (current.rev !== p.expectedRev) fail("conflict");
  const item = parseItem({ ...current, title: p.title ?? current.title, description: p.description ?? current.description,
    descriptionBy: p.description === undefined ? current.descriptionBy : actor.personId, rev: current.rev + 1, updatedAt: now });
  return saveRow(ctx, "items", item, current.rev) as V2Item;
}
function checkDependency(ctx: V2TransactionContext, deps: TasksDependencies, fromTask: string, toTask: string): void {
  // fromTask is the prerequisite, matching local dep-add and findPath(to, from).
  for (const taskId of [fromTask, toTask]) featureGate(ctx, deps, readTask(ctx, taskId).featureId);
  const edges = dependencies(ctx).map(d => ({ from: d.fromTask, to: d.toTask }));
  if (findPath(edges, toTask, fromTask)) fail("conflict");
}
export function applyDependency(ctx: V2TransactionContext, deps: TasksDependencies, command: DepCommand): V2Dependency {
  const p = command.payload;
  checkDependency(ctx, deps, p.fromTask, p.toTask);
  const current = dependencies(ctx).find(d => d.fromTask === p.fromTask && d.toTask === p.toTask);
  const entityId = dependencyId(p.fromTask, p.toTask);
  const latest = ctx.all("xt.version.latest", { kind: "task_deps", entityId })[0] as { rev: number } | undefined;
  if (p.expectedRev !== (latest?.rev ?? 0)) fail("conflict");
  if (command.type === "dep.remove") {
    if (!current) fail("not_found");
    const removed = { ...current, rev: current.rev + 1, updatedAt: ctx.scope.now };
    if (ctx.run("xt.dep.delete", { fromTask: p.fromTask, toTask: p.toTask, expectedRev: current.rev }) !== 1) fail("conflict");
    // Keep a version tombstone: deleting/re-adding an edge must never make an old CAS valid again.
    saveVersion(ctx, removed, "task_deps");
    return removed;
  }
  const { teamId, projectId, now, actor } = ctx.scope;
  const dep = parseDependency({ teamId, projectId, fromTask: p.fromTask, toTask: p.toTask,
    kind: command.payload.kind, when: command.payload.when, state: current?.state ?? null,
    createdBy: current?.createdBy ?? actor.personId, rev: p.expectedRev + 1, createdAt: current?.createdAt ?? now, updatedAt: now });
  return saveRow(ctx, "task_deps", dep, current?.rev) as V2Dependency;
}
