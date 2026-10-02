import {
  parseCommand, parseMigrationManifest, assertTransactionContext, fail, type V2TransactionContext, type V2MigrationManifest,
} from "../../lib/shared-ledger-contract-v2.js";
import { commandGate, type TasksDependencies } from "./policy.js";
import { checkScope, registerMapping, saveRow } from "./storage.js";

/** X13/X12 authorize the complete manifest, install all domains, then commit one migration event/receipt.
 * This subordinate hook neither issues a second receipt nor skips strict frozen manifest parsing.
 */
export function importTaskRows(ctx: V2TransactionContext, deps: TasksDependencies, inputCommand: unknown, inputManifest: unknown): void {
  assertTransactionContext(ctx);
  const command = parseCommand(inputCommand), manifest = parseMigrationManifest(inputManifest);
  if (command.type !== "migration.commit") fail();
  commandGate(ctx, command, deps); checkScope(ctx, manifest);
  if (manifest.serviceGeneration !== ctx.scope.serviceGeneration) fail("stale_generation");
  if (command.payload.batchId !== manifest.batchId || command.payload.manifestDigest !== manifest.manifestDigest
    || command.payload.authorizationAskId !== manifest.authorizationAskId || !manifest.featureIds.includes(command.payload.featureId)) fail("conflict");
  assertNewRows(ctx, manifest);
  for (const row of manifest.items) saveRow(ctx, "items", row);
  for (const row of manifest.tasks) saveRow(ctx, "tasks", row);
  for (const row of manifest.dependencies) saveRow(ctx, "task_deps", row);
  for (const mapping of manifest.mappings) if (mapping.kind === "item" || mapping.kind === "task") registerMapping(ctx, mapping);
}
function assertNewRows(ctx: V2TransactionContext, manifest: V2MigrationManifest): void {
  for (const [table, rows] of [["items", manifest.items], ["tasks", manifest.tasks]] as const) {
    for (const row of rows) if (ctx.all(`xt.${table}.get`, { id: row.id }).length) fail("conflict");
  }
  // Complete manifests contain both endpoints, so they cannot splice an unchecked cycle into old edges.
  for (const row of manifest.dependencies) {
    if (ctx.all("xt.task_deps.get", { fromTask: row.fromTask, toTask: row.toTask }).length) fail("conflict");
  }
}
