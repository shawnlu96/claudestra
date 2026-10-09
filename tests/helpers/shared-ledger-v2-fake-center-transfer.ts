/** S2C fake center: execution migrations and reverts to stage one, idempotent per batchId, with committed / unknown lookups.
 * A commit moves every listed feature's authorityMode and bumps its epoch; a lost response is resolved only by the lookup.
 */
import { fail, v2ObjectDigest } from "../../src/lib/shared-ledger-contract-v2.js";
import type { V2_ROUTES } from "../../src/lib/shared-ledger-contract-v2-routes.js";
import {
  authorizeAsk, featureView, liveWork, must,
  type FakeCenterState, type FakeMigrationResult, type FakeRevertResult,
} from "./shared-ledger-v2-fake-center-state.js";

type MigrationRequest = ReturnType<typeof V2_ROUTES.migrations.parseRequest>;
type RevertRequest = ReturnType<typeof V2_ROUTES.reverts.parseRequest>;
export interface TransferContext {
  state: FakeCenterState; scope: { teamId: string; projectId: string }; serviceGeneration: number; now: number;
}

/** dry-run validates and answers without writing; commit imports the manifest rows and flips the features to execution. */
export function migrate(t: TransferContext, { mode, manifest: m }: MigrationRequest): FakeMigrationResult {
  const { state, now } = t, prior = state.migrations.get(m.batchId);
  if (prior) return prior.manifestDigest === m.manifestDigest ? prior : fail("dedup_mismatch");
  if (m.serviceGeneration !== t.serviceGeneration) fail("stale_generation");
  authorizeAsk(state, m.authorizationAskId, now);
  for (const f of m.features) {
    const current = state.features.get(f.id);
    if (current?.authorityMode === "execution") fail("migration_blocked");
    if (current && current.authorityMode !== m.authorityFrom) fail("conflict");
  }
  const seq = state.serverSeq + 1;
  const result: FakeMigrationResult = { ...t.scope, schemaVersion: 2, batchId: m.batchId, manifestDigest: m.manifestDigest,
    serviceGeneration: t.serviceGeneration, serverSeq: seq, committedAt: now, mappings: m.mappings, featureIds: m.featureIds };
  if (mode === "dry-run") return result;
  for (const f of m.features) {
    const base = state.features.get(f.id) ?? f;
    state.features.set(f.id, { ...base, authorityMode: "execution", epoch: base.epoch + 1, rev: base.rev + 1, updatedAt: now });
  }
  for (const { featureId, dag } of m.dags) state.dags.set(featureId, dag);
  for (const task of m.tasks) state.tasks.set(task.id, task);
  for (const w of m.workflows) state.workflows.set(w.taskId, w);
  for (const ask of m.asks) if (!state.asks.has(ask.id)) state.asks.set(ask.id, ask);
  const ids = new Set(m.tasks.map(x => x.id));
  state.dependencies = [...state.dependencies.filter(d => !ids.has(d.fromTask) && !ids.has(d.toTask)), ...m.dependencies];
  state.steps = [...state.steps.filter(s => !ids.has(s.taskId)), ...m.steps];
  state.serverSeq = seq;
  state.migrations.set(m.batchId, result);
  return result;
}

/** Owner-authorized return to planning: every feature must be execution at expectedEpoch with no live work. */
export function revert(t: TransferContext, r: RevertRequest): FakeRevertResult {
  const { state, now } = t, requestDigest = v2ObjectDigest(r), prior = state.reverts.get(r.batchId);
  if (prior) return prior.requestDigest === requestDigest ? prior.result : fail("dedup_mismatch");
  authorizeAsk(state, r.authorizationAskId, now);
  for (const id of r.featureIds) {
    const f = must(state.features.get(id));
    if (f.authorityMode !== "execution") fail("execution_not_shared");
    if (f.epoch !== r.expectedEpoch) fail("stale_epoch");
    if (liveWork(state, id, now)) fail("migration_blocked");
  }
  const nextEpoch = r.expectedEpoch + 1, seq = state.serverSeq + 1;
  for (const id of r.featureIds) {
    const f = must(state.features.get(id));
    state.features.set(id, { ...f, authorityMode: "planning", epoch: nextEpoch, rev: f.rev + 1, updatedAt: now });
    for (const task of state.tasks.values()) if (task.featureId === id) state.leases.delete(task.id);
  }
  state.serverSeq = seq;
  const result: FakeRevertResult = { ...t.scope, schemaVersion: 2, batchId: r.batchId, featureIds: r.featureIds, nextEpoch,
    serviceGeneration: t.serviceGeneration, serverSeq: seq, committedAt: now,
    views: r.featureIds.map(id => featureView(state, t.scope, t.serviceGeneration, id)) };
  state.reverts.set(r.batchId, { requestDigest, result });
  return result;
}

/** GET migrations/{batchId} and reverts/{batchId}: committed with the stored result, otherwise unknown (never "failed"). */
export function lookup(t: TransferContext, kind: "migration" | "revert", batchId: string) {
  const result = kind === "migration" ? t.state.migrations.get(batchId) ?? null : t.state.reverts.get(batchId)?.result ?? null;
  return { ...t.scope, batchId, status: result ? "committed" as const : "unknown" as const, result };
}
