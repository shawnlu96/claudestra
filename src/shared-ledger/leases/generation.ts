import {
  assertTransactionContext, fail, parseGeneration, integer,
  type V2Generation, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import type { GenerationDependencies } from "./types.js";

export function readGeneration(context: V2TransactionContext): V2Generation | null {
  assertTransactionContext(context);
  const row = context.all("leases.generation.get")[0] as { generation: string } | undefined;
  return row ? parseGeneration(JSON.parse(row.generation)) : null;
}
export function assertCurrentGeneration(context: V2TransactionContext): V2Generation {
  const current = readGeneration(context);
  if (!current || current.serviceGeneration !== context.scope.serviceGeneration) fail("stale_generation");
  if (current.state !== "active") fail("migration_blocked");
  return current;
}
function putGeneration(context: V2TransactionContext, value: V2Generation): V2Generation {
  const next = parseGeneration(value);
  context.run("leases.generation.put", { generation: JSON.stringify(next) });
  return next;
}
/** Internal recovery API consumes the frozen DTO without adding a wire command.
 * Reserve the high-water mark before DB commit; gaps after rollback are safe,
 * reusing a generation after rolling back to an older backup is not.
 */
export function createGenerationDomain(deps: GenerationDependencies) {
  return {
    initialize(context: V2TransactionContext, value: V2Generation): V2Generation {
      assertTransactionContext(context); deps.assertRecoveryAuthorized(context);
      if (readGeneration(context)) fail("conflict");
      const next = parseGeneration(value);
      const highWater = integer(deps.generationHighWater(context));
      if (next.restoredFrom !== null || next.state !== "active" || next.startedAt !== context.scope.now
        || next.serviceGeneration !== context.scope.serviceGeneration
        || next.serviceGeneration <= highWater) fail("stale_generation");
      deps.reserveGeneration(context, highWater, next.serviceGeneration);
      return putGeneration(context, next);
    },
    restore(context: V2TransactionContext, value: V2Generation): V2Generation {
      assertTransactionContext(context); deps.assertRecoveryAuthorized(context);
      const current = readGeneration(context), next = parseGeneration(value);
      if (!current || current.serviceGeneration !== context.scope.serviceGeneration) fail("stale_generation");
      const highWater = integer(deps.generationHighWater(context));
      if (next.serviceGeneration <= Math.max(current.serviceGeneration, highWater)) fail("stale_generation");
      if (next.state !== "frozen" || next.serviceId !== current.serviceId || next.startedAt !== context.scope.now
        || next.restoredFrom?.serviceGeneration !== current.serviceGeneration
        || next.restoredFrom.serverSeq !== current.serverSeq || next.serverSeq !== current.serverSeq) fail("invalid_field");
      deps.reserveGeneration(context, highWater, next.serviceGeneration);
      context.run("leases.revokeAll");
      context.run("leases.boots.clear");
      return putGeneration(context, next);
    },
    activate(context: V2TransactionContext): V2Generation {
      assertTransactionContext(context); deps.assertRecoveryAuthorized(context);
      const current = readGeneration(context);
      if (!current || current.serviceGeneration !== context.scope.serviceGeneration) fail("stale_generation");
      if (current.state !== "frozen" || current.restoredFrom === null) fail("conflict");
      deps.assertRestoreReconciled(context, current);
      return putGeneration(context, { ...current, state: "active", restoreReconciledAt: context.scope.now });
    },
  };
}
