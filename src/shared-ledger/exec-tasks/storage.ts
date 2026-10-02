import {
  fail, parseTask, parseItem, parseDependency, parseIdMapping, v2ObjectDigest,
  assertTransactionContext, type V2Task, type V2Item, type V2Dependency, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { taskColumns, itemColumns, depColumns } from "./schema.js";

type Row = V2Task | V2Item | V2Dependency;
type Table = "tasks" | "items" | "task_deps";
const columns = { tasks: taskColumns, items: itemColumns, task_deps: depColumns };
const parsers = { tasks: parseTask, items: parseItem, task_deps: parseDependency };
export const dependencyId = (from: string, to: string): string => v2ObjectDigest([from, to]);
export function checkScope(ctx: V2TransactionContext, row: { teamId: string; projectId: string }): void {
  if (row.teamId !== ctx.scope.teamId || row.projectId !== ctx.scope.projectId) fail("forbidden");
}
function decode(table: Table, value: unknown): Row {
  const raw = { ...value as Record<string, unknown> };
  for (const [key, type] of Object.entries(columns[table])) if (type === "JSON" && typeof raw[key] === "string") raw[key] = JSON.parse(raw[key]);
  return parsers[table](raw);
}
export function readTask(ctx: V2TransactionContext, id: string): V2Task {
  assertTransactionContext(ctx);
  const row = ctx.all("xt.tasks.get", { id })[0];
  return row ? decode("tasks", row) as V2Task : fail("not_found");
}
export function readItem(ctx: V2TransactionContext, id: string): V2Item {
  const row = ctx.all("xt.items.get", { id })[0];
  return row ? decode("items", row) as V2Item : fail("not_found");
}
export function dependencies(ctx: V2TransactionContext): V2Dependency[] {
  return ctx.all("xt.task_deps.list").map(row => decode("task_deps", row) as V2Dependency);
}
export function saveRow(ctx: V2TransactionContext, table: Table, input: Row, expectedRev?: number): Row {
  const row = parsers[table](input);
  checkScope(ctx, row);
  const bindings: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "teamId" || key === "projectId") continue;
    bindings[key] = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
  }
  if (expectedRev !== undefined) bindings.expectedRev = expectedRev;
  if (ctx.run(`xt.${table}.${expectedRev === undefined ? "insert" : "update"}`, bindings) !== 1) fail("conflict");
  saveVersion(ctx, row, table);
  return row;
}
export function saveVersion(ctx: V2TransactionContext, row: Row, kind: Table): void {
  ctx.run("xt.version.insert", { kind, entityId: "id" in row ? row.id : dependencyId(row.fromTask, row.toTask),
    rev: row.rev, data: JSON.stringify(row) });
}
/** Internal migration hook: the command owner authorizes the manifest before registering mappings. */
export function registerMapping(ctx: V2TransactionContext, input: unknown): void {
  const mapping = parseIdMapping(input);
  if (mapping.kind !== "item" && mapping.kind !== "task") fail();
  const rows = ctx.all("xt.mapping.get", mapping) as Array<Record<string, unknown>>;
  if (rows.length) {
    if (rows.length !== 1 || Object.entries(mapping).some(([key, value]) => rows[0][key] !== value)) fail("conflict");
    return;
  }
  ctx.run("xt.mapping.insert", mapping);
}
