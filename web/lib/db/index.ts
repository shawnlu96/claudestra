import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { runAuthMigrations } from "./migrations/auth";
import { runSettingsMigrations } from "./migrations/settings";
import { DATA_ROOT } from "@/lib/data-root";

/**
 * Claudestra Web 数据根目录（~/.claude-orchestrator/web，CLAUDESTRA_DATA_ROOT 覆盖——
 * env 就是这个目录本身，口径见 lib/data-root.ts）。避免和 claude-os 的 ~/.claude-os 数据混淆。
 */
export { DATA_ROOT };
export const DB_DIR = path.join(DATA_ROOT, "db");

const dbCache = new Map<string, Database.Database>();

const migrations: Record<string, (db: Database.Database) => void> = {
  auth: runAuthMigrations,
  settings: runSettingsMigrations,
};

export function getDb(name = "auth"): Database.Database {
  let db = dbCache.get(name);
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(path.join(DB_DIR, `${name}.db`));
    db.pragma("journal_mode = WAL");
    migrations[name]?.(db);
    dbCache.set(name, db);
  }
  return db;
}
