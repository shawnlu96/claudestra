import {
  parseIntent, parseOperationResult, parseResource, resourceKey,
  type V2Intent, type V2OperationResult, type V2Resource, type V2Statement, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";

const scope = "teamId = $teamId AND projectId = $projectId";
export const intentSchema = {
  "intents.schema": `CREATE TABLE IF NOT EXISTS v2_intents (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, operationId TEXT NOT NULL, id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (teamId, projectId, operationId), UNIQUE (teamId, projectId, id))`,
  "intents.resources.schema": `CREATE TABLE IF NOT EXISTS v2_intent_resources (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, resourceKey TEXT NOT NULL, operationId TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (teamId, projectId, resourceKey))`,
  "intents.results.schema": `CREATE TABLE IF NOT EXISTS v2_operation_results (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, operationId TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (teamId, projectId, operationId))`,
};
export const intentStatements: Readonly<Record<string, V2Statement>> = {
  "intents.get": { mode: "read", sql: `SELECT body, fingerprint FROM v2_intents WHERE ${scope} AND operationId = $operationId` },
  "intents.insert": { mode: "write", sql: `INSERT INTO v2_intents (teamId, projectId, operationId, id, fingerprint, body)
    VALUES ($teamId, $projectId, $operationId, $id, $fingerprint, $body)` },
  "intents.update": { mode: "write", sql: `UPDATE v2_intents SET body = $body WHERE ${scope} AND operationId = $operationId` },
  "intents.resources": { mode: "read", sql: `SELECT body FROM v2_intent_resources WHERE ${scope}` },
  "intents.hold": { mode: "write", sql: `INSERT INTO v2_intent_resources (teamId, projectId, resourceKey, operationId, body)
    VALUES ($teamId, $projectId, $resourceKey, $operationId, $body)` },
  "intents.resource.update": { mode: "write", sql: `UPDATE v2_intent_resources SET body = $body
    WHERE ${scope} AND resourceKey = $resourceKey AND operationId = $operationId` },
  "intents.free": { mode: "write", sql: `DELETE FROM v2_intent_resources WHERE ${scope} AND operationId = $operationId` },
  "intents.result": { mode: "read", sql: `SELECT body FROM v2_operation_results WHERE ${scope} AND operationId = $operationId` },
  "intents.result.insert": { mode: "write", sql: `INSERT INTO v2_operation_results (teamId, projectId, operationId, body)
    VALUES ($teamId, $projectId, $operationId, $body)` },
  "intents.result.reconcile": { mode: "write", sql: `UPDATE v2_operation_results SET body = $body
    WHERE ${scope} AND operationId = $operationId` },
};
export function getIntent(ctx: V2TransactionContext, operationId: string) {
  const row = ctx.all("intents.get", { operationId })[0] as { body: string; fingerprint: string } | undefined;
  return row ? { intent: parseIntent(JSON.parse(row.body)), fingerprint: row.fingerprint } : null;
}
export function getResult(ctx: V2TransactionContext, operationId: string): V2OperationResult | null {
  const row = ctx.all("intents.result", { operationId })[0] as { body: string } | undefined;
  return row ? parseOperationResult(JSON.parse(row.body)) : null;
}
export function getResources(ctx: V2TransactionContext): V2Resource[] {
  return ctx.all("intents.resources").map(row => parseResource(JSON.parse((row as { body: string }).body)));
}
export function saveIntent(ctx: V2TransactionContext, intent: V2Intent): void {
  ctx.run("intents.update", { operationId: intent.operationId, body: JSON.stringify(parseIntent(intent)) });
}
export function holdResources(ctx: V2TransactionContext, intent: V2Intent): void {
  for (const key of intent.resources) {
    const resource = parseResource({ key, taskId: intent.taskId, intentId: intent.id, operationId: intent.operationId,
      epoch: intent.epoch, bootId: intent.bootId, serviceGeneration: intent.serviceGeneration,
      scope: "intent", state: "held", acquiredAt: ctx.scope.now });
    ctx.run("intents.hold", { resourceKey: resourceKey(key), operationId: intent.operationId, body: JSON.stringify(resource) });
  }
}
export function markUnknown(ctx: V2TransactionContext, intent: V2Intent): void {
  for (const resource of getResources(ctx).filter(r => r.operationId === intent.operationId)) {
    ctx.run("intents.resource.update", { resourceKey: resourceKey(resource.key), operationId: intent.operationId,
      body: JSON.stringify({ ...resource, state: "unknown" }) });
  }
}
