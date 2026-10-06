import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import {
  createTransactionOwner, parseTask, parseItem, parseFeature, parseWorkflow, parseLendOrder, parseLendResult,
  parseCommand, V2_COMMAND_NAMES, fail, type V2TransactionContext, type V2TransactionScope,
  type V2TransactionBackend, type V2Command, type V2Statement,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES, V2_COMMAND_FIXTURES, V2_FIXTURE_SCOPE, V2_FIXTURE_FENCE } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { createTasksDomain, execTasksSchema, execTasksStatements, type TasksCommand, type TasksDependencies } from "../src/shared-ledger/exec-tasks";
import { saveRow } from "../src/shared-ledger/exec-tasks/storage";

export const fixtureTask = () => parseTask(V2_DTO_FIXTURES.task.valid);
export const fixtureManifest = () => structuredClone(V2_DTO_FIXTURES.migrationManifest.valid) as Record<string, any>;
export const command = (type: V2Command["type"], payload: Record<string, unknown> = {}, requestId = `request-${type}`): TasksCommand => {
  const base = V2_COMMAND_FIXTURES.find(f => f.type === type)!.valid;
  return parseCommand({ ...base, requestId, payload: { ...base.payload, ...payload } }) as TasksCommand;
};
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
export function harness(seed = true) {
  const db = new Database(":memory:"); databases.push(db);
  const scope: V2TransactionScope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, now: 2000,
    actor: { kind: "person", personId: "person", instanceId: "local", serviceId: null, representedPersonId: null,
      orderId: null, projects: ["project"], actions: [...V2_COMMAND_NAMES] } };
  const statements: Record<string, V2Statement> = { ...execTasksStatements };
  for (const table of ["feature", "workflow", "order", "result"]) {
    db.run(`CREATE TABLE fixture_${table} (teamId TEXT,projectId TEXT,id TEXT,data TEXT,PRIMARY KEY(teamId,projectId,id))`);
    statements[`fixture.${table}`] = { mode: "read", sql: `SELECT data FROM fixture_${table} WHERE teamId=$teamId AND projectId=$projectId AND id=$id` };
  }
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, statements, execTasksSchema);
  const denied = new Set<string>(), calls: string[] = [];
  const read = (ctx: V2TransactionContext, table: string, id: string) => {
    const row = ctx.all(`fixture.${table}`, { id })[0] as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  };
  const deps: TasksDependencies = {
    authorize(_ctx, c) { calls.push(c.type); if (denied.has(c.type)) fail("forbidden"); },
    authorizeTask(_ctx, c) { calls.push(`role:${c.type}`); if (denied.has(`role:${c.type}`)) fail("forbidden"); },
    feature: (ctx, id) => parseFeature(read(ctx, "feature", id)),
    workflow: (ctx, id) => parseWorkflow(read(ctx, "workflow", id)),
    order: ctx => { const row = read(ctx, "order", "order"); return row ? parseLendOrder(row) : null; },
    result: (ctx, id) => parseLendResult(read(ctx, "result", id)),
  };
  const domain = createTasksDomain(deps);
  db.transaction(() => owner.installSchema(ctx => domain.installSchema(ctx)))();
  const tx = <T>(fn: (ctx: V2TransactionContext) => T, activeScope = scope) =>
    db.transaction(() => owner.inCallerTransaction(activeScope, Object.keys(statements), fn))();
  const put = (table: string, id: string, row: object) => {
    db.run(`INSERT OR REPLACE INTO fixture_${table} VALUES (?,?,?,?)`, [scope.teamId, scope.projectId, id, JSON.stringify(row)]);
  };
  put("feature", "feature", { ...parseFeature(V2_DTO_FIXTURES.feature.valid), authorityMode: "execution" });
  put("workflow", "task", parseWorkflow(V2_DTO_FIXTURES.workflow.valid));
  if (seed) tx(ctx => {
    saveRow(ctx, "items", parseItem(V2_DTO_FIXTURES.item.valid));
    saveRow(ctx, "tasks", fixtureTask());
    saveRow(ctx, "tasks", { ...fixtureTask(), id: "task-two" });
    saveRow(ctx, "tasks", { ...fixtureTask(), id: "task-three" });
  });
  const run = (c: unknown, activeScope = scope) => tx(ctx => domain.applyInTransaction(ctx, c as TasksCommand), activeScope);
  const task = (id = "task") => db.query("SELECT * FROM tasks WHERE id=?").get(id) as Record<string, any>;
  const snapshot = () => Object.fromEntries(["items", "tasks", "task_deps", "exec_task_versions", "exec_task_id_map", "exec_events", "exec_command_receipts"]
    .map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { db, scope, deps, domain, tx, run, put, task, denied, calls, snapshot };
}
