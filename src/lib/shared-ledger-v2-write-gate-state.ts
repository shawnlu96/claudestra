import type { Database } from "bun:sqlite";
import { LedgerError } from "./ledger-store.js";

export type GateRow = Record<string, string | number | null>;
export type GateTask = GateRow & { id: string; project: string; featureId: string | null; extra: string };
const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MALFORMED = "sharedFeatureId 畸形";
const observed = new Set<string>();

function sharedFeature(task: { extra: unknown }): { id: string | null; malformed: boolean } {
  let extra: unknown = task.extra;
  if (typeof extra === "string") {
    try { extra = JSON.parse(extra); }
    catch { return { id: null, malformed: true }; }
  }
  const shared = extra && typeof extra === "object" ? (extra as Record<string, unknown>).sharedFeatureId : undefined;
  if (shared === undefined) return { id: null, malformed: false };
  return typeof shared === "string" && FEATURE_ID.test(shared) ? { id: shared, malformed: false } : { id: null, malformed: true };
}

/** Read-only diagnostic for show-style callers; the stored field is never rewritten here. */
export function sharedFeatureDiagnostic(task: { extra: unknown }): string | null {
  return sharedFeature(task).malformed ? MALFORMED : null;
}

/** Keep both persisted associations: clearing extra or rebinding a card cannot erase its old authority inside a transaction.
 * A malformed stored sharedFeatureId is treated as unshared (stage-one behavior) and observed, never a permanent lockout. */
export function gateFeatureIds(task: GateTask | undefined): string[] {
  if (!task) return [];
  const shared = sharedFeature(task);
  if (shared.malformed && !observed.has(task.id)) {
    observed.add(task.id); // Once per card per process: the key never grows with the card's content.
    console.warn(`[shared-ledger-write-gate] 卡 ${task.id} 的 ${MALFORMED}，按非共享卡处理`);
  }
  return [...new Set([task.featureId, shared.id].filter((id): id is string => typeof id === "string" && !!id))];
}

export function gateTask(db: Database, id: string): GateTask | undefined {
  return (db.query("SELECT * FROM tasks WHERE id=?").get(id) as GateTask | null) ?? undefined;
}

const IMMUTABLE = ["tasks", "task_deps", "task_steps", "task_workflows", "items", "meta", "features", "dag_versions", "dag_bindings"] as const;
const BOOKKEEPING = ["scheduler_intents", "scheduler_resources", "scheduler_sessions", "scheduler_merges"] as const;
/**
 * Tables whose touched rows the gate records. Precondition: no source writes them with INSERT OR REPLACE / REPLACE INTO /
 * UPDATE OR REPLACE. REPLACE deletes the conflicting row without firing DELETE triggers (recursive_triggers is off), so the
 * replaced image would never be recorded and the change would pass unseen. tests/shared-ledger-v2-stage2-gate-replace.test.ts
 * enforces this over src/ with this exported list.
 */
export const TRACKED: readonly string[] = [...IMMUTABLE, ...BOOKKEEPING];
export const localIntent = (row: GateRow | undefined): boolean => !!row && ["ensure_session", "retire"].includes(String(row.action));

/**
 * Change tracking replaces whole-table snapshots: connection-local TEMP triggers record each touched row's transaction-origin
 * image while a gate is active, so cost follows the rows a write touches, not the ledger size. The temp objects roll back with
 * the transaction and are rebuilt whenever the main schema version moves, so a migrated column is never silently untracked.
 */
const rowSql = (db: Database, table: string, alias: string): string => {
  const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  return `json_object(${cols.map(c => `'${c}', ${alias}."${c}"`).join(", ")})`;
};
const selectSql = new WeakMap<Database, Map<string, string>>();

function install(db: Database): void {
  for (const { name } of db.query("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name LIKE 'gate\\_%' ESCAPE '\\'").all() as { name: string }[]) {
    db.run(`DROP TRIGGER temp."${name}"`);
  }
  db.run("CREATE TEMP TABLE IF NOT EXISTS gate_meta (version INTEGER NOT NULL, active INTEGER NOT NULL)");
  db.run("CREATE TEMP TABLE IF NOT EXISTS gate_rows (tbl TEXT NOT NULL, rid INTEGER NOT NULL, old TEXT, PRIMARY KEY (tbl, rid))");
  db.run("DELETE FROM temp.gate_meta");
  db.run("DELETE FROM temp.gate_rows");
  const selects = new Map<string, string>();
  const present = new Set((db.query(`SELECT name FROM main.sqlite_master WHERE type='table' AND name IN (${TRACKED.map(() => "?").join()})`)
    .all(...TRACKED) as { name: string }[]).map(r => r.name));
  for (const table of TRACKED.filter(t => present.has(t))) {
    // No conflict clause: an outer UPSERT / OR <policy> would override it inside the trigger body, so a duplicate is skipped by NOT EXISTS.
    const record = (rid: string, old: string, when = "") => `INSERT INTO gate_rows SELECT '${table}', ${rid}, ${old}
      WHERE ${when}NOT EXISTS (SELECT 1 FROM temp.gate_rows WHERE tbl='${table}' AND rid=${rid});`;
    const on = `ON main.${table} WHEN (SELECT active FROM temp.gate_meta)`;
    db.run(`CREATE TEMP TRIGGER gate_${table}_i AFTER INSERT ${on} BEGIN ${record("NEW.rowid", "NULL")} END`);
    db.run(`CREATE TEMP TRIGGER gate_${table}_u AFTER UPDATE ${on} BEGIN ${record("OLD.rowid", rowSql(db, table, "OLD"))}
      ${record("NEW.rowid", "NULL", "NEW.rowid <> OLD.rowid AND ")} END`);
    db.run(`CREATE TEMP TRIGGER gate_${table}_d AFTER DELETE ${on} BEGIN ${record("OLD.rowid", rowSql(db, table, "OLD"))} END`);
    selects.set(table, `SELECT ${rowSql(db, table, "t")} AS row FROM main.${table} t WHERE rowid=?`);
  }
  selectSql.set(db, selects);
  db.query("INSERT INTO temp.gate_meta SELECT schema_version, 0 FROM pragma_schema_version").run();
}

/** Starts recording inside the caller's writer transaction; returns false when this connection already records. */
export function beginTracking(db: Database): void {
  let current = false;
  try { current = !!(db.query("SELECT m.version = s.schema_version AS ok FROM temp.gate_meta m, pragma_schema_version s").get() as { ok: number } | null)?.ok; }
  catch { current = false; } // No temp objects yet, or a rollback discarded them.
  if (!current || !selectSql.has(db)) install(db);
  db.query("DELETE FROM temp.gate_rows").run(); // A swallowed endTracking failure must not leak a previous transaction's origin images.
  db.query("UPDATE temp.gate_meta SET active=1").run();
}
export function endTracking(db: Database): void {
  try { db.query("UPDATE temp.gate_meta SET active=0").run(); db.query("DELETE FROM temp.gate_rows").run(); }
  catch { /* the rolled-back transaction already discarded the temp rows */ }
}

interface RowChange { table: string; rid: number; before: string | null; after: string | null }
export type Mark = Map<string, string | null>;
const current = (db: Database, table: string, rid: number): string | null =>
  (db.query(selectSql.get(db)!.get(table)!).get(rid) as { row: string } | null)?.row ?? null;
const touched = (db: Database) => db.query("SELECT tbl, rid, old FROM temp.gate_rows").all() as { tbl: string; rid: number; old: string | null }[];

/** Current image of every row touched so far; changes are later measured from here instead of the transaction origin. */
export function markTracked(db: Database): Mark {
  return new Map(touched(db).map(r => [`${r.tbl}\0${r.rid}`, current(db, r.tbl, r.rid)]));
}
function trackedChanges(db: Database, mark?: Mark): RowChange[] {
  const changes: RowChange[] = [];
  for (const r of touched(db)) {
    const key = `${r.tbl}\0${r.rid}`, before = mark?.has(key) ? mark.get(key)! : r.old, after = current(db, r.tbl, r.rid);
    if (before !== after) changes.push({ table: r.tbl, rid: r.rid, before, after });
  }
  return changes;
}
/** Task images changed since the mark (or transaction origin), split per card id so a reused rowid cannot hide a card. */
export function taskChanges(db: Database, mark?: Mark): { id: string; before?: GateTask; after?: GateTask }[] {
  const byId = new Map<string, { id: string; before?: GateTask; after?: GateTask }>();
  for (const change of trackedChanges(db, mark).filter(c => c.table === "tasks")) {
    for (const [side, row] of [["before", change.before], ["after", change.after]] as const) {
      if (row === null) continue;
      const task = JSON.parse(row) as GateTask, entry = byId.get(task.id) ?? { id: task.id };
      entry[side] = task;
      byId.set(task.id, entry);
    }
  }
  return [...byId.values()].filter(e => JSON.stringify(e.before) !== JSON.stringify(e.after));
}
/** Origin image of a card inside the active gate: its first recorded image, or the unchanged current row. */
export function originTask(db: Database, id: string): GateTask | undefined {
  for (const r of db.query("SELECT old FROM temp.gate_rows WHERE tbl='tasks' AND old IS NOT NULL").all() as { old: string }[]) {
    const task = JSON.parse(r.old) as GateTask;
    if (task.id === id) return task;
  }
  const row = (db.query("SELECT rowid AS rid FROM tasks WHERE id=?").get(id) as { rid: number } | null);
  if (!row) return undefined;
  const recorded = db.query("SELECT 1 FROM temp.gate_rows WHERE tbl='tasks' AND rid=?").get(row.rid);
  return recorded ? undefined : JSON.parse(current(db, "tasks", row.rid)!) as GateTask;
}
export const taskJson = (task: GateTask | undefined): string | undefined => task === undefined ? undefined : JSON.stringify(task);

type Snapshot = Map<string, GateRow[]>;
const keys: Record<string, readonly string[]> = {
  scheduler_intents: ["id"], scheduler_resources: ["project", "resource"], scheduler_sessions: ["taskId", "role"], scheduler_merges: ["intentId"],
};
const rowKey = (table: string, row: GateRow): string => JSON.stringify(keys[table].map(key => row[key]));

/** S2V owns project-wide cleanup protection. Here the scope's own locks and intents must remain local bookkeeping only.
 * Only rows changed inside the scope are compared; other tasks' resource rows stay out of scope as before. */
export function assertExecutorChanges(db: Database, mark: Mark, taskId: string, stale: boolean): void {
  const before: Snapshot = new Map(), after: Snapshot = new Map();
  for (const change of trackedChanges(db, mark)) {
    if ((IMMUTABLE as readonly string[]).includes(change.table)) throw new LedgerError("forbidden", `执行令牌不能写 ${change.table}`);
    for (const [side, image] of [[before, change.before], [after, change.after]] as const) {
      const row = image === null ? null : JSON.parse(image) as GateRow;
      if (row && (change.table !== "scheduler_resources" || row.taskId === taskId)) side.set(change.table, [...side.get(change.table) ?? [], row]);
    }
  }
  const changedIntents = new Map([...before.get("scheduler_intents") ?? [], ...after.get("scheduler_intents") ?? []].map(row => [row.id, row]));
  const intentOf = (id: unknown): GateRow | undefined => changedIntents.get(id as string)
    ?? (db.query("SELECT * FROM scheduler_intents WHERE id=?").get(id as string) as GateRow | null) ?? undefined;
  for (const table of ["scheduler_intents", "scheduler_resources"] as const) {
    const previous = new Map((before.get(table) ?? []).map(row => [rowKey(table, row), row]));
    const next = new Map((after.get(table) ?? []).map(row => [rowKey(table, row), row]));
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const old = previous.get(key), now = next.get(key);
      if (JSON.stringify(old) === JSON.stringify(now)) continue;
      const allowed = (row: GateRow) => row.taskId === taskId && localIntent(table === "scheduler_intents" ? row : intentOf(row.intentId));
      if ((old && !allowed(old)) || (now && !allowed(now))) throw new LedgerError("forbidden", "执行令牌不能改中心意图或资源");
      if (stale && !(table === "scheduler_intents" && old?.status === "submitted" && now?.status === "unknown"
        && JSON.stringify({ ...old, status: now.status, receipt: now.receipt, updatedAt: now.updatedAt }) === JSON.stringify(now))) {
        rejectStaleClaim();
      }
    }
  }
  for (const table of ["scheduler_sessions", "scheduler_merges"]) {
    const previous = new Map((before.get(table) ?? []).map(row => [rowKey(table, row), row]));
    const next = new Map((after.get(table) ?? []).map(row => [rowKey(table, row), row]));
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const old = previous.get(key), now = next.get(key);
      if (JSON.stringify(old) === JSON.stringify(now)) continue;
      if ((old && old.taskId !== taskId) || (now && now.taskId !== taskId)) throw new LedgerError("forbidden", "执行令牌只能写本卡簿记");
      if (stale) rejectStaleClaim();
    }
  }
}

/** Stage-two refusals outside the store's error union travel as conflict; the original code name stays in the text. */
export function rejectStaleClaim(): never {
  throw new LedgerError("conflict", "stale_claim: 认领 fence 已过期，只准把已提交意图结算为 unknown");
}
