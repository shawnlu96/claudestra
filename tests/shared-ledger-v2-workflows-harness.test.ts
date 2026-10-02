import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import {
  createTransactionOwner, parseTask, parseFeature, parseCommand, V2_COMMAND_NAMES, fail,
  type V2TransactionContext, type V2TransactionScope, type V2TransactionBackend, type V2Command, type V2Statement, type V2Task,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES, V2_COMMAND_FIXTURES, V2_FIXTURE_SCOPE, V2_FIXTURE_FENCE } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { createTasksDomain, execTasksSchema, execTasksStatements, readTask, type TasksCommand } from "../src/shared-ledger/exec-tasks";
import { saveRow } from "../src/shared-ledger/exec-tasks/storage";
import {
  createWorkflowsDomain, createWorkflow, execWorkflowsSchema, execWorkflowsStatements, readWorkflow,
  type WorkflowsCommand, type WorkflowsDependencies,
} from "../src/shared-ledger/exec-workflows";

export const fixtureTask = (patch: Partial<V2Task> = {}) => parseTask({ ...V2_DTO_FIXTURES.task.valid as object, ...patch });
export const nodes = [
  { key: "a", oneLine: "节点 a", deps: [], fileGlobs: ["src/a.ts"], estimate: "1h" },
  { key: "b", oneLine: "节点 b", deps: ["a"], fileGlobs: ["src/b.ts"], estimate: "1h" },
  { key: "c", oneLine: "节点 c", deps: [], fileGlobs: [], estimate: "" },
];
export const command = (type: V2Command["type"], payload: Record<string, unknown> = {}, requestId = `request-${type}`) => {
  const base = V2_COMMAND_FIXTURES.find(f => f.type === type)!.valid;
  return parseCommand({ ...base, requestId, payload: { ...base.payload, ...payload } }) as WorkflowsCommand;
};
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** Composition root stand-in for X12: X1 tasks + X14 workflows in one bun:sqlite caller transaction. */
export function harness() {
  const db = new Database(":memory:"); databases.push(db);
  const scope: V2TransactionScope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, now: 2000,
    actor: { kind: "person", personId: "person", instanceId: "local", serviceId: null, representedPersonId: null,
      orderId: null, projects: ["project"], actions: [...V2_COMMAND_NAMES] } };
  const statements: Record<string, V2Statement> = { ...execTasksStatements, ...execWorkflowsStatements,
    "fixture.feature.get": { mode: "read", sql: "SELECT data FROM fixture_feature WHERE teamId=$teamId AND projectId=$projectId AND id=$id" },
    "fixture.feature.update": { mode: "write", sql: `UPDATE fixture_feature SET data=$data, rev=$rev
      WHERE teamId=$teamId AND projectId=$projectId AND id=$id AND rev=$expectedRev` },
  };
  db.run("CREATE TABLE fixture_feature (teamId TEXT,projectId TEXT,id TEXT,rev INTEGER,data TEXT,PRIMARY KEY(teamId,projectId,id))");
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, statements, { ...execTasksSchema, ...execWorkflowsSchema });
  const denied = new Set<string>(), calls: string[] = [], faults = new Set<string>();
  const feature = (ctx: V2TransactionContext, id: string) => {
    const row = ctx.all("fixture.feature.get", { id })[0] as { data: string } | undefined;
    return row ? parseFeature(JSON.parse(row.data)) : fail("not_found");
  };
  const deps: WorkflowsDependencies = {
    authorize(_ctx, c) { calls.push(c.type); if (denied.has(c.type)) fail("forbidden"); },
    authorizeWorkflow(_ctx, c) { calls.push(`wf:${c.type}`); if (denied.has(`wf:${c.type}`)) fail("forbidden"); },
    feature,
    saveFeature(ctx, next, expectedRev) {
      if (ctx.run("fixture.feature.update", { id: next.id, rev: next.rev, data: JSON.stringify(next), expectedRev }) !== 1) fail("conflict");
      if (faults.has("afterFeature")) throw new Error("injected after feature write");
    },
    task: (ctx, id) => readTask(ctx, id),
    saveTask(ctx, next, expectedRev) {
      saveRow(ctx, "tasks", next, expectedRev);
      if (faults.has("afterTask")) throw new Error("injected after task write");
    },
  };
  const domain = createWorkflowsDomain(deps);
  const tasks = createTasksDomain({
    authorize() {}, authorizeTask() {}, feature, workflow: readWorkflow, order: () => null, result: () => fail("not_found"),
  });
  db.transaction(() => owner.installSchema(ctx => { tasks.installSchema(ctx); domain.installSchema(ctx); }))();
  const tx = <T>(fn: (ctx: V2TransactionContext) => T, activeScope = scope) =>
    db.transaction(() => owner.inCallerTransaction(activeScope, Object.keys(statements), fn))();
  const putFeature = (patch: Record<string, unknown> = {}) => {
    const row = parseFeature({ ...V2_DTO_FIXTURES.feature.valid as object, authorityMode: "execution", currentVersion: 0, ...patch });
    db.run("INSERT OR REPLACE INTO fixture_feature VALUES (?,?,?,?,?)", [row.teamId, row.projectId, row.id, row.rev, JSON.stringify(row)]);
  };
  putFeature();
  const settings: Parameters<typeof createWorkflow>[2] = { template: "code", templateVersion: 1, authorFamily: "codex", fallback: ["claude"] };
  tx(ctx => {
    for (const id of ["task", "task-two", "task-three"]) createWorkflow(ctx, saveRow(ctx, "tasks", fixtureTask({ id })) as V2Task, settings);
  });
  const run = (c: unknown, activeScope = scope) => tx(ctx => domain.applyInTransaction(ctx, c as WorkflowsCommand), activeScope);
  const runTask = (c: unknown) => tx(ctx => tasks.applyInTransaction(ctx, c as TasksCommand));
  const row = (table: string, where = "1") => db.query(`SELECT * FROM ${table} WHERE ${where}`).all() as Record<string, any>[];
  const featureRow = () => JSON.parse(row("fixture_feature")[0].data);
  const snapshot = () => Object.fromEntries(["fixture_feature", "tasks", "exec_task_versions", "task_workflows", "task_steps",
    "exec_dag_versions", "exec_dag_bindings", "exec_source_events", "exec_events", "exec_command_receipts"]
    .map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { db, scope, deps, domain, tx, run, runTask, row, featureRow, putFeature, snapshot, denied, calls, faults };
}
export type Harness = ReturnType<typeof harness>;
export function unchanged(h: Harness, fn: () => unknown, code: string) {
  const before = h.snapshot();
  let thrown: unknown = null;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(`expected ${code}`);
  if ((thrown as Error).message !== code) throw thrown;
  if (JSON.stringify(h.snapshot()) !== JSON.stringify(before)) throw new Error("rows changed after failed command");
}
