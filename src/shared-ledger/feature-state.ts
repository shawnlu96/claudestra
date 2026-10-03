import type { SharedLedgerFeature, SharedLedgerTaskProjection } from "../lib/shared-ledger-contract.js";
import { Store, encode, decode } from "./store.js";

/** Home ledgers finish tasks at `verified`; older or external sources may report `done`. Both count as complete. */
export function isSharedLedgerTaskComplete(stage: string): boolean {
  return stage === "done" || stage === "verified";
}

/** Planning changes and projection updates must derive completion from the same current DAG and explicit mirror states. */
export function refreshFeatureState(store: Store, f: SharedLedgerFeature): void {
  const tasks = store.all<{ data: string }>("SELECT data FROM task_mirrors WHERE featureId=?", f.id).map((r) => decode<SharedLedgerTaskProjection>(r.data));
  f.executorInstanceIds = [...new Set(tasks.flatMap((t) => t.executorInstanceId ? [t.executorInstanceId] : []))];
  // Only explicit task state counts as complete; absent mirror rows remain missing, never inferred done.
  const table = f.authorityMode === "source" ? "source_dag_mirrors" : "dag_versions";
  const dagRow = store.get<{ data: string }>(`SELECT data FROM ${table} WHERE featureId=? AND version=?`, f.id, f.version);
  const bindings = dagRow ? decode<{ bindings: { taskId: string }[] }>(dagRow.data).bindings : [];
  const mirrors = store.all<{ taskId: string; data: string }>("SELECT taskId,data FROM task_mirrors WHERE featureId=?", f.id);
  const bound = bindings.map((b) => mirrors.find((t) => t.taskId === b.taskId)).filter((t) => t !== undefined);
  f.counts.completed = bound.filter((t) => isSharedLedgerTaskComplete(decode<SharedLedgerTaskProjection>(t.data).stage)).length;
  f.counts.blocked = bound.filter((t) => decode<SharedLedgerTaskProjection>(t.data).stage === "blocked").length;
  f.counts.missing = bindings.length - bound.length;
  f.status = f.counts.total > 0 && f.counts.completed === f.counts.total ? "done" : f.counts.blocked ? "blocked" : tasks.length ? "active" : "planned";
}

/**
 * Startup repair for rows derived under an older completion rule. Derived state only: rev, events and serverSeq stay
 * untouched, and unchanged rows are not rewritten, so repeated runs are no-ops. Returns the number of rewritten features.
 */
export function recomputeFeatureStates(store: Store): number {
  return store.write(() => {
    let changed = 0;
    for (const row of store.all<{ teamId: string; id: string; data: string }>("SELECT teamId,id,data FROM features ORDER BY teamId,id")) {
      const f = decode<SharedLedgerFeature>(row.data);
      refreshFeatureState(store, f);
      const next = encode(f);
      if (next === encode(decode(row.data))) continue;
      store.run("UPDATE features SET data=? WHERE teamId=? AND id=?", next, row.teamId, row.id);
      changed++;
    }
    return changed;
  });
}
