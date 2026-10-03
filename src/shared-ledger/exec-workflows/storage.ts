import {
  fail, parseStep, parseWorkflow, assertTransactionContext, type V2Step, type V2Workflow, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { stepColumns, workflowColumns } from "./schema.js";

type Table = "task_steps" | "task_workflows";
const columns = { task_steps: stepColumns, task_workflows: workflowColumns };
const parsers = { task_steps: parseStep, task_workflows: parseWorkflow };
export function checkScope(ctx: V2TransactionContext, row: { teamId: string; projectId: string }): void {
  if (row.teamId !== ctx.scope.teamId || row.projectId !== ctx.scope.projectId) fail("forbidden");
}
function decode<T>(table: Table, value: unknown): T {
  const raw = { ...value as Record<string, unknown> };
  for (const [key, type] of Object.entries(columns[table])) if (type === "JSON" && typeof raw[key] === "string") raw[key] = JSON.parse(raw[key]);
  return parsers[table](raw) as T;
}
/** X12 wires this as the X1 `workflow` reader: same context, no cache. */
export function readWorkflow(ctx: V2TransactionContext, taskId: string): V2Workflow {
  assertTransactionContext(ctx);
  const row = ctx.all("xw.task_workflows.get", { taskId })[0];
  return row ? decode<V2Workflow>("task_workflows", row) : fail("not_found");
}
export function findStep(ctx: V2TransactionContext, taskId: string, step: string, round: number): V2Step | null {
  const row = ctx.all("xw.task_steps.get", { taskId, step, round })[0];
  return row ? decode<V2Step>("task_steps", row) : null;
}
export function readSteps(ctx: V2TransactionContext, taskId: string): V2Step[] {
  assertTransactionContext(ctx);
  return ctx.all("xw.task_steps.list", { taskId }).map(row => decode<V2Step>("task_steps", row));
}
/** Insert when expectedRev is absent, otherwise a single-row CAS update; the schema trigger enforces rev+1. */
export function saveRow<T extends V2Step | V2Workflow>(ctx: V2TransactionContext, table: Table, input: T, expectedRev?: number): T {
  const row = parsers[table](input) as T;
  checkScope(ctx, row);
  const bindings: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "teamId" || key === "projectId") continue;
    bindings[key] = typeof value === "object" && value !== null ? JSON.stringify(value) : value as string | number | null;
  }
  if (expectedRev !== undefined) {
    if (row.rev !== expectedRev + 1) fail("conflict");
    bindings.expectedRev = expectedRev;
  }
  if (ctx.run(`xw.${table}.${expectedRev === undefined ? "insert" : "update"}`, bindings) !== 1) fail("conflict");
  return row;
}
