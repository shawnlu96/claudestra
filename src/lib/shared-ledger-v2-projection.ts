/**
 * S2P snapshot sync: pull the center feature view and land it through the projection writer when it is newer than what landed.
 * Read-only toward the center: nothing is ever written back. S2F injects the returned function as S2Q's `sync(p, featureId)`.
 */
import type { Database } from "bun:sqlite";
import { writeExecutionProjection, type ExecutionProjectionOutcome, type ProjectionCenterRef } from "./shared-ledger-v2-projection-write.js";

export { writeExecutionProjection, releaseProjectionGuard, landedCenterSeq } from "./shared-ledger-v2-projection-write.js";
export type { ExecutionProjectionOutcome, ExecutionProjectionRef, ProjectionCenterRef } from "./shared-ledger-v2-projection-write.js";

export interface ExecutionProjectionSyncPort {
  /** Center GET features/{featureId} for the local project p and local feature id (S2T); the body is parsed by the writer. */
  snapshot(p: string, featureId: string): Promise<unknown>;
  /** Optional: X13 / X13B batch id while the feature carries `migrating`. */
  batchId?(featureId: string): string | undefined;
  /** Optional: center binding for a migrating feature whose mode file has none yet. */
  center?(p: string, featureId: string): ProjectionCenterRef | undefined;
  observe?(taskId: string, code: string): void;
}

export function syncExecutionProjection(db: Database, port: ExecutionProjectionSyncPort) {
  return async (p: string, featureId: string): Promise<ExecutionProjectionOutcome> => {
    const view = await port.snapshot(p, featureId);
    const batchId = port.batchId?.(featureId), center = port.center?.(p, featureId);
    return writeExecutionProjection(db, view, { project: p, featureId, ...(batchId ? { batchId } : {}), ...(center ? { center } : {}),
      ...(port.observe ? { observe: port.observe } : {}) });
  };
}
