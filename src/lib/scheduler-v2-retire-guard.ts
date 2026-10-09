/** Table guards cover project-wide cleanup that bypasses the event write gate. */
import type { Database } from "bun:sqlite";

export const PROJECTION_GUARD_TABLES = ["v2_projection_guard", "v2_projection_writer"] as const;
export const PROJECTION_GUARD_COLUMNS = { v2_projection_guard: ["taskId"], v2_projection_writer: ["token"] } as const;
export const PROJECTION_GUARD_TABLE_DDL = [
  "CREATE TABLE IF NOT EXISTS v2_projection_guard (taskId TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id))",
  "CREATE TABLE IF NOT EXISTS v2_projection_writer (token TEXT PRIMARY KEY NOT NULL)",
] as const;

export const PROJECTION_GUARD_TRIGGER_DDL = (["DELETE", "UPDATE"] as const).map((operation) => ({
  name: `v2_projection_resources_${operation.toLowerCase()}`,
  sql: `CREATE TRIGGER IF NOT EXISTS v2_projection_resources_${operation.toLowerCase()} BEFORE ${operation} ON scheduler_resources
    WHEN EXISTS (SELECT 1 FROM v2_projection_guard WHERE taskId = OLD.taskId)
    AND NOT EXISTS (SELECT 1 FROM v2_projection_writer)
    AND NOT EXISTS (SELECT 1 FROM scheduler_intents WHERE id = OLD.intentId AND action IN ('ensure_session','retire'))
    BEGIN SELECT RAISE(IGNORE); END`,
}));
export const PROJECTION_GUARD_DDL = [...PROJECTION_GUARD_TABLE_DDL, ...PROJECTION_GUARD_TRIGGER_DDL.map((t) => t.sql)];

const canonicalSql = (sql: string): string => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "").replace(/\s+/g, " ").trim();

/** Recheck definitions on each new connection: a same-name weakened trigger must fail closed. */
export function installProjectionGuard(db: Database): void {
  db.transaction(() => {
    for (const sql of PROJECTION_GUARD_DDL) db.prepare(sql).run();
    for (const [table, columns] of Object.entries(PROJECTION_GUARD_COLUMNS)) {
      const object = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table) as { type: string } | null;
      if (object?.type !== "table") throw new Error(`Invalid projection guard table: ${table}`);
      const actual = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (columns.some((column) => !actual.some((c) => c.name === column))) throw new Error(`Invalid projection guard table: ${table}`);
    }
    if (db.prepare("SELECT 1 FROM v2_projection_writer LIMIT 1").get()) throw new Error("Projection writer must be empty");
    for (const trigger of PROJECTION_GUARD_TRIGGER_DDL) {
      const row = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger.name) as { tbl_name: string; sql: string } | null;
      if (!row || row.tbl_name !== "scheduler_resources" || canonicalSql(row.sql) !== canonicalSql(trigger.sql)) {
        throw new Error(`Invalid projection guard trigger: ${trigger.name}`);
      }
    }
  }).immediate();
}

export function guardProjectionTasks(db: Database, add: readonly string[], remove: readonly string[]): void {
  db.transaction(() => {
    for (const taskId of add) db.prepare("INSERT OR IGNORE INTO v2_projection_guard (taskId) VALUES (?)").run(taskId);
    for (const taskId of remove) db.prepare("DELETE FROM v2_projection_guard WHERE taskId = ?").run(taskId);
  }).immediate();
}

/** A distinct token makes nested writers safe; no writer privilege survives commit or rollback. */
export function withProjectionWriter<T>(db: Database, fn: () => T): T {
  return db.transaction(() => {
    const token = crypto.randomUUID();
    db.prepare("INSERT INTO v2_projection_writer (token) VALUES (?)").run(token);
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Projection writer must be synchronous");
      return result;
    } finally { db.prepare("DELETE FROM v2_projection_writer WHERE token = ?").run(token); }
  }).immediate();
}

export function isProjectionGuarded(db: Database, taskId: string): boolean {
  const object = db.prepare("SELECT type FROM sqlite_master WHERE name = 'v2_projection_guard'").get() as { type: string } | null;
  if (!object) return false; // Raw pre-upgrade connections have no projection guards; openLedger installs and validates them.
  if (object.type !== "table") throw new Error("Invalid projection guard table: v2_projection_guard");
  return !!db.prepare("SELECT 1 FROM v2_projection_guard WHERE taskId = ?").get(taskId);
}
