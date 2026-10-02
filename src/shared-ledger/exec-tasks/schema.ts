import type { V2SchemaContext, V2Statement } from "../../lib/shared-ledger-contract-v2-transaction.js";

// Each DTO field has its own column; only named nested schemas use JSON columns.
export const taskColumns = {
  teamId: "TEXT", projectId: "TEXT", id: "TEXT", itemId: "TEXT", featureId: "TEXT", title: "TEXT", plan: "TEXT",
  kind: "TEXT", stage: "TEXT", stageBefore: "TEXT", round: "INTEGER", specRev: "INTEGER", rev: "INTEGER",
  createdAt: "INTEGER", updatedAt: "INTEGER", homeInstanceId: "TEXT", executor: "JSON", executorInstanceId: "TEXT",
  pm: "JSON", repository: "TEXT", branch: "TEXT", pr: "INTEGER", head: "TEXT", spec: "JSON",
  collaboration: "JSON", review: "JSON", delivery: "JSON",
};
export const itemColumns = {
  teamId: "TEXT", projectId: "TEXT", id: "TEXT", featureId: "TEXT", title: "TEXT", ownerWords: "TEXT", ownerWordsBy: "TEXT",
  description: "TEXT", descriptionBy: "TEXT", priority: "TEXT", status: "TEXT", oneLine: "TEXT", next: "TEXT",
  rev: "INTEGER", createdAt: "INTEGER", updatedAt: "INTEGER",
};
export const depColumns = {
  teamId: "TEXT", projectId: "TEXT", fromTask: "TEXT", toTask: "TEXT", kind: "TEXT", when: "TEXT", state: "TEXT",
  createdBy: "TEXT", rev: "INTEGER", createdAt: "INTEGER", updatedAt: "INTEGER",
};
export const scopeWhere = "teamId=$teamId AND projectId=$projectId";
export const taskSchema: Record<string, string> = {};
export const taskStatements: Record<string, V2Statement> = {};
const definitions = { tasks: taskColumns, items: itemColumns, task_deps: depColumns };
for (const [table, columns] of Object.entries(definitions)) {
  const keys = table === "task_deps" ? ["fromTask", "toTask"] : ["id"];
  const fields = Object.keys(columns), where = `${scopeWhere} AND ${keys.map(k => `"${k}"=$${k}`).join(" AND ")}`;
  taskSchema[`xt.${table}`] = `CREATE TABLE IF NOT EXISTS ${table} (${Object.entries(columns)
    .map(([k, type]) => `"${k}" ${type === "JSON" ? "TEXT" : type}`).join(",")}, PRIMARY KEY(teamId,projectId,${keys.join(",")}))`;
  taskStatements[`xt.${table}.get`] = { mode: "read", sql: `SELECT * FROM ${table} WHERE ${where}` };
  taskStatements[`xt.${table}.list`] = { mode: "read", sql: `SELECT * FROM ${table} WHERE ${scopeWhere}` };
  taskStatements[`xt.${table}.insert`] = { mode: "write",
    sql: `INSERT INTO ${table} (${fields.map(k => `"${k}"`).join(",")}) VALUES (${fields.map(k => `$${k}`).join(",")})` };
  const changes = fields.filter(k => !["teamId", "projectId", ...keys].includes(k)).map(k => `"${k}"=$${k}`).join(",");
  taskStatements[`xt.${table}.update`] = { mode: "write", sql: `UPDATE ${table} SET ${changes} WHERE ${where} AND rev=$expectedRev` };
}
taskStatements["xt.dep.delete"] = { mode: "write",
  sql: `DELETE FROM task_deps WHERE ${scopeWhere} AND fromTask=$fromTask AND toTask=$toTask AND rev=$expectedRev` };
taskSchema["xt.versions"] = `CREATE TABLE IF NOT EXISTS exec_task_versions (teamId TEXT,projectId TEXT,kind TEXT,
  entityId TEXT,rev INTEGER,data TEXT, PRIMARY KEY(teamId,projectId,kind,entityId,rev))`;
taskStatements["xt.version.insert"] = { mode: "write", sql: `INSERT INTO exec_task_versions VALUES ($teamId,$projectId,$kind,$entityId,$rev,$data)` };
taskStatements["xt.version.latest"] = { mode: "read", sql: `SELECT rev FROM exec_task_versions
  WHERE ${scopeWhere} AND kind=$kind AND entityId=$entityId ORDER BY rev DESC LIMIT 1` };
taskSchema["xt.mappings"] = `CREATE TABLE IF NOT EXISTS exec_task_id_map (teamId TEXT,projectId TEXT,kind TEXT,
  sourceInstanceId TEXT,sourceId TEXT,id TEXT,registeredBy TEXT,registeredInstanceId TEXT,registeredAt INTEGER,
  PRIMARY KEY(teamId,projectId,kind,sourceInstanceId,sourceId), UNIQUE(teamId,projectId,kind,id))`;
taskStatements["xt.mapping.get"] = { mode: "read", sql: `SELECT * FROM exec_task_id_map WHERE ${scopeWhere}
  AND kind=$kind AND ((sourceInstanceId=$sourceInstanceId AND sourceId=$sourceId) OR id=$id)` };
taskStatements["xt.mapping.insert"] = { mode: "write", sql: `INSERT INTO exec_task_id_map
  VALUES ($teamId,$projectId,$kind,$sourceInstanceId,$sourceId,$id,$personId,$instanceId,$now)` };
for (const table of ["exec_task_versions", "exec_task_id_map"]) {
  for (const action of ["UPDATE", "DELETE"]) taskSchema[`xt.${table}.${action}`] =
    `CREATE TRIGGER IF NOT EXISTS ${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END`;
}
export function installTaskSchema(context: V2SchemaContext): void {
  for (const name of Object.keys(taskSchema)) context.install(name);
}
