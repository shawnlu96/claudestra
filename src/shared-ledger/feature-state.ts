import type { SharedLedgerFeature, SharedLedgerTaskProjection } from "../lib/shared-ledger-contract.js";
import { Store, decode } from "./store.js";

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
  f.counts.completed = bound.filter((t) => decode<SharedLedgerTaskProjection>(t.data).stage === "done").length;
  f.counts.blocked = bound.filter((t) => decode<SharedLedgerTaskProjection>(t.data).stage === "blocked").length;
  f.counts.missing = bindings.length - bound.length;
  f.status = f.counts.total > 0 && f.counts.completed === f.counts.total ? "done" : f.counts.blocked ? "blocked" : tasks.length ? "active" : "planned";
}
