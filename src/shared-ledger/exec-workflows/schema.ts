import type { V2SchemaContext, V2Statement } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { journalSchema, journalStatements } from "../exec-tasks/journal.js";

// Columns mirror the frozen X0 DTOs; only named nested schemas are JSON columns.
export const stepColumns = {
  teamId: "TEXT", projectId: "TEXT", taskId: "TEXT", step: "TEXT", round: "INTEGER", executor: "JSON", state: "TEXT",
  headFrom: "TEXT", headTo: "TEXT", verdict: "TEXT", verified: "JSON", claims: "JSON",
  rev: "INTEGER", createdAt: "INTEGER", updatedAt: "INTEGER",
};
export const workflowColumns = {
  teamId: "TEXT", projectId: "TEXT", taskId: "TEXT", template: "TEXT", templateVersion: "INTEGER", mode: "TEXT",
  authorFamily: "TEXT", fallback: "JSON", specRev: "INTEGER", rev: "INTEGER", createdAt: "INTEGER", updatedAt: "INTEGER",
};
const scopeWhere = "teamId=$teamId AND projectId=$projectId";
const tables = {
  task_steps: { columns: stepColumns, keys: ["taskId", "step", "round"] },
  task_workflows: { columns: workflowColumns, keys: ["taskId"] },
};
const workflowSchema: Record<string, string> = {};
const workflowStatements: Record<string, V2Statement> = {};
for (const [table, { columns, keys }] of Object.entries(tables)) {
  const fields = Object.keys(columns), where = `${scopeWhere} AND ${keys.map(k => `"${k}"=$${k}`).join(" AND ")}`;
  workflowSchema[`xw.${table}`] = `CREATE TABLE IF NOT EXISTS ${table} (${Object.entries(columns)
    .map(([k, type]) => `"${k}" ${type === "JSON" ? "TEXT" : type}`).join(",")}, PRIMARY KEY(teamId,projectId,${keys.join(",")}))`;
  // Every row change is a +1 revision on the same key; deletes are never allowed (history stays in events).
  workflowSchema[`xw.${table}.rev`] = `CREATE TRIGGER IF NOT EXISTS ${table}_rev BEFORE UPDATE ON ${table}
    WHEN NEW.rev <> OLD.rev + 1 OR ${keys.map(k => `NEW."${k}" IS NOT OLD."${k}"`).join(" OR ")}
    BEGIN SELECT RAISE(ABORT, 'revision'); END`;
  workflowSchema[`xw.${table}.DELETE`] = `CREATE TRIGGER IF NOT EXISTS ${table}_DELETE BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'immutable'); END`;
  workflowStatements[`xw.${table}.get`] = { mode: "read", sql: `SELECT * FROM ${table} WHERE ${where}` };
  workflowStatements[`xw.${table}.insert`] = { mode: "write",
    sql: `INSERT INTO ${table} (${fields.map(k => `"${k}"`).join(",")}) VALUES (${fields.map(k => `$${k}`).join(",")})` };
  const changes = fields.filter(k => !["teamId", "projectId", ...keys].includes(k)).map(k => `"${k}"=$${k}`).join(",");
  workflowStatements[`xw.${table}.update`] = { mode: "write", sql: `UPDATE ${table} SET ${changes} WHERE ${where} AND rev=$expectedRev` };
}
workflowStatements["xw.task_steps.list"] = { mode: "read", sql: `SELECT * FROM task_steps WHERE ${scopeWhere} AND taskId=$taskId
  ORDER BY round, step` };

// Active bindings enforce uniqueness; version snapshots retain cancelled and subsequently rebound nodes.
workflowSchema["xw.dags"] = `CREATE TABLE IF NOT EXISTS exec_dag_versions (teamId TEXT,projectId TEXT,featureId TEXT,
  version INTEGER,nodes TEXT,createdBy TEXT,createdAt INTEGER, PRIMARY KEY(teamId,projectId,featureId,version))`;
workflowSchema["xw.bindings"] = `CREATE TABLE IF NOT EXISTS exec_dag_bindings (teamId TEXT,projectId TEXT,featureId TEXT,
  nodeKey TEXT,taskId TEXT,boundVersion INTEGER,boundBy TEXT,boundAt INTEGER,
  PRIMARY KEY(teamId,projectId,featureId,nodeKey), UNIQUE(teamId,projectId,taskId))`;
workflowSchema["xw.bindingVersions"] = `CREATE TABLE IF NOT EXISTS exec_dag_binding_versions (
  teamId TEXT,projectId TEXT,featureId TEXT,version INTEGER,nodeKey TEXT,taskId TEXT,
  PRIMARY KEY(teamId,projectId,featureId,version,nodeKey), UNIQUE(teamId,projectId,featureId,version,taskId))`;
for (const action of ["UPDATE", "DELETE"]) workflowSchema[`xw.bindingVersions.${action}`] =
  `CREATE TRIGGER IF NOT EXISTS exec_dag_binding_versions_${action} BEFORE ${action} ON exec_dag_binding_versions
  BEGIN SELECT RAISE(ABORT, 'immutable'); END`;
workflowStatements["xw.binding.snapshot"] = { mode: "write", sql: `INSERT INTO exec_dag_binding_versions
  VALUES ($teamId,$projectId,$featureId,$version,$nodeKey,$taskId)` };
workflowSchema["xw.bindings.UPDATE"] = `CREATE TRIGGER IF NOT EXISTS exec_dag_bindings_UPDATE BEFORE UPDATE ON exec_dag_bindings
  BEGIN SELECT RAISE(ABORT, 'immutable'); END`;
workflowStatements["xw.dag.get"] = { mode: "read", sql: `SELECT nodes FROM exec_dag_versions WHERE ${scopeWhere}
  AND featureId=$featureId AND version=$version` };
workflowStatements["xw.dag.insert"] = { mode: "write", sql: `INSERT INTO exec_dag_versions
  VALUES ($teamId,$projectId,$featureId,$version,$nodes,$personId,$now)` };
workflowStatements["xw.binding.list"] = { mode: "read", sql: `SELECT nodeKey,taskId FROM exec_dag_binding_versions WHERE ${scopeWhere}
  AND featureId=$featureId AND version=$version ORDER BY nodeKey` };
workflowStatements["xw.binding.byTask"] = { mode: "read", sql: `SELECT featureId,nodeKey FROM exec_dag_bindings WHERE ${scopeWhere}
  AND taskId=$taskId` };
workflowStatements["xw.binding.insert"] = { mode: "write", sql: `INSERT INTO exec_dag_bindings
  VALUES ($teamId,$projectId,$featureId,$nodeKey,$taskId,$boundVersion,$personId,$now)` };
workflowStatements["xw.binding.delete"] = { mode: "write", sql: `DELETE FROM exec_dag_bindings WHERE ${scopeWhere}
  AND featureId=$featureId AND nodeKey=$nodeKey AND taskId=$taskId` };

// Source-side events are observation attachments keyed by their origin; serverSeq comes from the central journal.
workflowSchema["xw.sources"] = `CREATE TABLE IF NOT EXISTS exec_source_events (teamId TEXT,projectId TEXT,
  sourceInstanceId TEXT,sourceSeq INTEGER,serverSeq INTEGER,attachedBy TEXT,attachedAt INTEGER,data TEXT,
  PRIMARY KEY(teamId,projectId,sourceInstanceId,sourceSeq))`;
for (const action of ["UPDATE", "DELETE"]) workflowSchema[`xw.sources.${action}`] =
  `CREATE TRIGGER IF NOT EXISTS exec_source_events_${action} BEFORE ${action} ON exec_source_events
  BEGIN SELECT RAISE(ABORT, 'immutable'); END`;
workflowStatements["xw.source.get"] = { mode: "read", sql: `SELECT serverSeq,data FROM exec_source_events WHERE ${scopeWhere}
  AND sourceInstanceId=$sourceInstanceId AND sourceSeq=$sourceSeq` };
workflowStatements["xw.source.insert"] = { mode: "write", sql: `INSERT INTO exec_source_events
  VALUES ($teamId,$projectId,$sourceInstanceId,$sourceSeq,$serverSeq,$personId,$now,$data)` };
workflowStatements["xw.source.list"] = { mode: "read", sql: `SELECT serverSeq,data FROM exec_source_events WHERE ${scopeWhere}
  ORDER BY serverSeq, rowid` };

/** X14 shares X1's exec_events/receipts journal so every execution event uses one central serverSeq. */
export const execWorkflowsSchema = { ...journalSchema, ...workflowSchema };
export const execWorkflowsStatements = { ...journalStatements, ...workflowStatements };
export function installWorkflowSchema(ctx: V2SchemaContext): void {
  for (const name of Object.keys(execWorkflowsSchema)) ctx.install(name);
}
