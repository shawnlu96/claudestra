import type { V2SchemaContext, V2Statement, V2TransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { assertTransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { parseLendClaim, parseLendLease, parseLendOrder, parseLendResult, type V2LendOrder } from "../../lib/shared-ledger-contract-v2-lend.js";
import { fail, id } from "../../lib/shared-ledger-contract-v2-validation.js";

const scoped = "team_id = $teamId AND project_id = $projectId";
const tables = { order: "v2_lend_orders", claim: "v2_lend_claims", lease: "v2_lend_leases", result: "v2_lend_results" } as const;
type RowKind = keyof typeof tables;
const parsers = { order: parseLendOrder, claim: parseLendClaim, lease: parseLendLease, result: parseLendResult };
export const lendSchema: Readonly<Record<string, string>> = Object.freeze({
  "lend.schema.orders": `CREATE TABLE IF NOT EXISTS v2_lend_orders (
    order_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, project_id TEXT NOT NULL,
    task_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)`,
  "lend.schema.live": `CREATE UNIQUE INDEX IF NOT EXISTS v2_lend_live
    ON v2_lend_orders(team_id, project_id, task_id) WHERE status IN ('pooled', 'claimed', 'unknown')`,
  ...Object.fromEntries((["claim", "lease", "result"] as const).map(kind => [`lend.schema.${kind}`,
    `CREATE TABLE IF NOT EXISTS ${tables[kind]} (
      order_id TEXT PRIMARY KEY REFERENCES v2_lend_orders(order_id), team_id TEXT NOT NULL, project_id TEXT NOT NULL, body TEXT NOT NULL)`])),
  "lend.schema.operation": `CREATE UNIQUE INDEX IF NOT EXISTS v2_lend_result_operation
    ON v2_lend_results(team_id, project_id, json_extract(body, '$.operationId'))`,
});
export const lendStatements: Readonly<Record<string, V2Statement>> = Object.freeze({
  ...Object.fromEntries(Object.entries(tables).flatMap(([kind, table]) => [
    [`lend.${kind}.read`, { mode: "read", sql: `SELECT body FROM ${table} WHERE ${scoped} AND order_id = $orderId` }],
    ...(kind === "order" ? [] : [[`lend.${kind}.insert`, { mode: "write", sql: `INSERT OR IGNORE INTO ${table}
      (team_id, project_id, order_id, body) VALUES ($teamId, $projectId, $orderId, $body)` }]]),
  ])) as Record<string, V2Statement>,
  "lend.order.insert": { mode: "write", sql: `INSERT OR IGNORE INTO v2_lend_orders
    (team_id, project_id, order_id, task_id, status, body) VALUES ($teamId, $projectId, $orderId, $taskId, $status, $body)` },
  "lend.order.update": { mode: "write", sql: `UPDATE v2_lend_orders SET status = $status, body = $body
    WHERE ${scoped} AND order_id = $orderId AND body = $previous` },
  "lend.lease.update": { mode: "write", sql: `UPDATE v2_lend_leases SET body = $body
    WHERE ${scoped} AND order_id = $orderId AND body = $previous` },
});
export function installLendSchema(context: V2SchemaContext): void {
  for (const name of Object.keys(lendSchema)) context.install(name);
}
export function readLendRow<K extends RowKind>(context: V2TransactionContext, kind: K, orderId: string): ReturnType<typeof parsers[K]> | null {
  assertTransactionContext(context);
  const row = context.all(`lend.${kind}.read`, { orderId: id(orderId) })[0] as { body: string } | undefined;
  return row ? parsers[kind](JSON.parse(row.body)) as ReturnType<typeof parsers[K]> : null;
}
export function insertLendRow<K extends RowKind>(context: V2TransactionContext, kind: K, input: ReturnType<typeof parsers[K]>): void {
  assertTransactionContext(context);
  const row = parsers[kind](input);
  if (row.teamId !== context.scope.teamId || row.projectId !== context.scope.projectId) fail("forbidden");
  const bindings = { orderId: row.orderId, body: JSON.stringify(row), ...(kind === "order" ? { taskId: row.taskId, status: (row as V2LendOrder).status } : {}) };
  if (context.run(`lend.${kind}.insert`, bindings) !== 1) fail("conflict");
}
export function updateLendOrder(context: V2TransactionContext, previous: V2LendOrder, next: V2LendOrder): V2LendOrder {
  assertTransactionContext(context);
  const row = parseLendOrder(next);
  if (row.teamId !== context.scope.teamId || row.projectId !== context.scope.projectId) fail("forbidden");
  if (row.orderId !== previous.orderId || row.taskId !== previous.taskId) fail("stale_order");
  if (context.run("lend.order.update", {
    orderId: previous.orderId, previous: JSON.stringify(previous), status: row.status, body: JSON.stringify(row),
  }) !== 1) fail("conflict");
  return row;
}
