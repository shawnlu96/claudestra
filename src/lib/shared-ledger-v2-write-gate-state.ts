import type { Database } from "bun:sqlite";
import { LedgerError } from "./ledger-store.js";

export type GateRow = Record<string, string | number | null>;
export type GateTask = GateRow & { id: string; project: string; featureId: string | null; extra: string };
const tableExists = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Keep both persisted associations: clearing extra or rebinding a card cannot erase its old authority inside a transaction. */
export function gateFeatureIds(task: GateTask | undefined): string[] {
  if (!task) return [];
  const extra = JSON.parse(task.extra) as Record<string, unknown>;
  const shared = extra.sharedFeatureId;
  if (shared !== undefined && (typeof shared !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(shared))) {
    throw new LedgerError("forbidden", "无法核验卡的共享归属");
  }
  return [...new Set([task.featureId, shared].filter((id): id is string => typeof id === "string" && !!id))];
}

export function gateTasks(db: Database, includeUnshared = false): Map<string, GateTask> {
  return new Map((db.query(`SELECT * FROM tasks${includeUnshared ? "" : " WHERE featureId IS NOT NULL OR json_type(extra, '$.sharedFeatureId') IS NOT NULL"}`)
    .all() as GateTask[]).map(row => [row.id, row]));
}

export function gateTask(db: Database, id: string): GateTask | undefined {
  return (db.query("SELECT * FROM tasks WHERE id=?").get(id) as GateTask | null) ?? undefined;
}

const IMMUTABLE = ["tasks", "task_deps", "task_steps", "task_workflows", "items", "meta", "features", "dag_versions", "dag_bindings"] as const;
const BOOKKEEPING = ["scheduler_intents", "scheduler_resources", "scheduler_sessions", "scheduler_merges"] as const;
type Snapshot = Map<string, GateRow[]>;
export const localIntent = (row: GateRow | undefined): boolean => !!row && ["ensure_session", "retire"].includes(String(row.action));

/** S2V owns project-wide cleanup protection. Here the scope's own locks and intents must remain local bookkeeping only. */
export function executorSnapshot(db: Database, taskId: string): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const table of [...IMMUTABLE, ...BOOKKEEPING]) {
    if (!tableExists(db, table)) continue;
    const scoped = table === "scheduler_resources";
    snapshot.set(table, db.query(`SELECT * FROM ${table}${scoped ? " WHERE taskId=?" : ""} ORDER BY rowid`)
      .all(...(scoped ? [taskId] : [])) as GateRow[]);
  }
  return snapshot;
}

const keys: Record<string, readonly string[]> = {
  scheduler_intents: ["id"], scheduler_resources: ["project", "resource"], scheduler_sessions: ["taskId", "role"], scheduler_merges: ["intentId"],
};
const rowKey = (table: string, row: GateRow): string => JSON.stringify(keys[table].map(key => row[key]));

export function assertExecutorChanges(before: Snapshot, after: Snapshot, taskId: string, stale: boolean): void {
  for (const table of IMMUTABLE) {
    if (JSON.stringify(before.get(table)) !== JSON.stringify(after.get(table))) throw new LedgerError("forbidden", `执行令牌不能写 ${table}`);
  }
  const intents = new Map([...before.get("scheduler_intents") ?? [], ...after.get("scheduler_intents") ?? []].map(row => [row.id, row]));
  for (const table of ["scheduler_intents", "scheduler_resources"] as const) {
    const previous = new Map((before.get(table) ?? []).map(row => [rowKey(table, row), row]));
    const current = new Map((after.get(table) ?? []).map(row => [rowKey(table, row), row]));
    for (const key of new Set([...previous.keys(), ...current.keys()])) {
      const old = previous.get(key), next = current.get(key);
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      const allowed = (row: GateRow) => row.taskId === taskId && localIntent(table === "scheduler_intents" ? row : intents.get(row.intentId));
      if ((old && !allowed(old)) || (next && !allowed(next))) throw new LedgerError("forbidden", "执行令牌不能改中心意图或资源");
      if (stale && !(table === "scheduler_intents" && old?.status === "submitted" && next?.status === "unknown"
        && JSON.stringify({ ...old, status: next.status, receipt: next.receipt, updatedAt: next.updatedAt }) === JSON.stringify(next))) {
        rejectStaleClaim();
      }
    }
  }
  for (const table of ["scheduler_sessions", "scheduler_merges"]) {
    const previous = new Map((before.get(table) ?? []).map(row => [rowKey(table, row), row]));
    const current = new Map((after.get(table) ?? []).map(row => [rowKey(table, row), row]));
    for (const key of new Set([...previous.keys(), ...current.keys()])) {
      const old = previous.get(key), next = current.get(key);
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      if ((old && old.taskId !== taskId) || (next && next.taskId !== taskId)) throw new LedgerError("forbidden", "执行令牌只能写本卡簿记");
      if (stale) rejectStaleClaim();
    }
  }
}

export function rejectStaleClaim(): never {
  const error = new LedgerError("forbidden", "stale_claim");
  // Preserve LedgerError transport while the stage-two code is outside the store's existing error union.
  Object.defineProperty(error, "code", { value: "stale_claim" });
  throw error;
}
