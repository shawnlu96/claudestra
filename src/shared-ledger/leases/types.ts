import type {
  V2Command, V2Feature, V2Task, V2TransactionContext, V2Generation,
} from "../../lib/shared-ledger-contract-v2.js";

export type LeaseCommand = Extract<V2Command, { type: "lease.acquire" | "lease.renew" | "lease.release" | "home.change" }>;
export type HomeChange = Extract<LeaseCommand, { type: "home.change" }>;
/** X12 adapters read/write authoritative rows using the supplied transaction.
 * Callbacks must not use cached observations, swallow failures, or start async work.
 */
export interface LeaseDependencies {
  readTask(context: V2TransactionContext, taskId: string): V2Task;
  readFeature(context: V2TransactionContext, featureId: string): V2Feature;
  workflowRev(context: V2TransactionContext, taskId: string): number;
  /** CAS current epoch/home; home changes update every task's home in this transaction. */
  advanceFeature(context: V2TransactionContext, feature: V2Feature, epoch: number, homeInstanceId: string): void;
  /** Verify project owner, current approval bind and registration of the next home. */
  assertHomeAuthorization(context: V2TransactionContext, command: HomeChange, feature: V2Feature): void;
  /** Read intents/resources/operations/workers/lend; timeout never settles unknown. */
  settlement(context: V2TransactionContext, featureId: string): { workersSettled: boolean; lendSettled: boolean; unknownCount: number };
}
export interface GenerationDependencies {
  /** Local recovery/operator authorization, not merely a project-owner role. */
  assertRecoveryAuthorized(context: V2TransactionContext): void;
  /** Durable high-water mark OUTSIDE the restored backup. */
  generationHighWater(context: V2TransactionContext): number;
  /** Durable compare-and-set outside backups, before DB commit. A rollback may burn a number. */
  reserveGeneration(context: V2TransactionContext, expectedHighWater: number, nextGeneration: number): void;
  /** Check confirmed receipts/sequence reconciliation service-wide before thawing. */
  assertRestoreReconciled(context: V2TransactionContext, generation: V2Generation): void;
}
