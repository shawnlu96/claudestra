import { parseMigrationManifest, type V2MigrationManifest } from "../../lib/shared-ledger-contract-v2-transfer.js";
import type { V2LendOrder } from "../../lib/shared-ledger-contract-v2-lend.js";
import { assertFence, v2ObjectDigest } from "../../lib/shared-ledger-contract-v2-integrity.js";
import type { V2TransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { fail } from "../../lib/shared-ledger-contract-v2-validation.js";
import { assertScope, assertTaskOrder, fenceOf, sameWorker, synchronous, type LendPorts } from "./checks.js";
import { insertLendRow, readLendRow } from "./storage.js";

function validateBundle(context: V2TransactionContext, manifest: V2MigrationManifest, order: V2LendOrder): void {
  const claim = manifest.lendClaims.find(r => r.orderId === order.orderId);
  const lease = manifest.lendLeases.find(r => r.orderId === order.orderId);
  const result = manifest.lendResults.find(r => r.orderId === order.orderId);
  const task = manifest.tasks.find(t => t.id === order.taskId)!;
  const mapping = manifest.mappings.find(m => m.kind === "order" && m.id === order.orderId);
  if (mapping?.sourceId !== order.orderId || task.featureId !== order.featureId || task.homeInstanceId !== order.homeInstanceId) fail("migration_blocked");
  for (const row of [claim, lease, result]) {
    if (row && (row.taskId !== order.taskId || !sameWorker(row.worker, order.worker))) fail("migration_blocked");
  }
  if (claim && (claim.grantId !== order.grantId || claim.grantDigest !== order.grantDigest)) fail("migration_blocked");
  if (lease && (lease.expiresAt !== order.leaseUntil || lease.leaseMs !== order.leaseMs)) fail("migration_blocked");
  if (result ? result.resultDigest !== order.resultDigest || result.operationId !== order.resultOperationId
    : order.resultDigest !== null || order.resultOperationId !== null) fail("migration_blocked");
  if (order.status === "done" && !result) fail("migration_blocked");
  if (order.status === "pooled" || order.status === "claimed") {
    assertFence(fenceOf(context.scope), fenceOf(order)); assertTaskOrder(task, order);
    if (order.homeInstanceId !== manifest.sourceInstanceId || result) fail("migration_blocked");
    if (order.status === "claimed") {
      if (!claim || !lease || lease.expiresAt <= context.scope.now) fail("migration_blocked");
      const step = manifest.steps.find(s => s.taskId === order.taskId && s.step === order.step && s.round === order.round);
      if (!step || step.state !== "assigned" || !sameWorker(step.executor, order.worker) || step.headFrom !== order.head) fail("migration_blocked");
    } else if (claim || lease || order.worker !== null || order.leaseUntil !== null) fail("migration_blocked");
  }
}
function sameRow(a: unknown, b: unknown): boolean { return v2ObjectDigest(a) === v2ObjectDigest(b); }
/** Import is a separate composition-root operation, never an external lend command or an implicit claim.
 * X13 commits the whole approved manifest and migration receipt in the same X12 transaction.
 */
export function importLendManifest(context: V2TransactionContext, ports: LendPorts, input: unknown): V2LendOrder[] {
  const manifest = parseMigrationManifest(input); assertScope(context, manifest);
  if (manifest.serviceGeneration !== context.scope.serviceGeneration) fail("stale_generation");
  if (!context.scope.actor.actions.includes("migration.commit") || context.scope.actor.orderId !== null) fail("forbidden");
  if (context.scope.actor.instanceId !== manifest.sourceInstanceId) fail("wrong_home");
  synchronous(ports.authorizeImport(context, manifest));
  for (const order of manifest.lendOrders) {
    validateBundle(context, manifest, order);
    const old = readLendRow(context, "order", order.orderId);
    if (old) {
      if (!sameRow(old, order)) fail("dedup_mismatch");
    } else insertLendRow(context, "order", order);
    for (const kind of ["claim", "lease", "result"] as const) {
      const rows = kind === "claim" ? manifest.lendClaims : kind === "lease" ? manifest.lendLeases : manifest.lendResults;
      const row = rows.find(r => r.orderId === order.orderId) ?? null;
      const existing = readLendRow(context, kind, order.orderId);
      if (old) {
        if (!sameRow(existing, row)) fail("dedup_mismatch");
      } else if (row) insertLendRow(context, kind, row);
    }
  }
  return manifest.lendOrders;
}
