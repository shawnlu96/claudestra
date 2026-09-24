import type Database from "better-sqlite3";

export function runAuthMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // 原生壳的「记住登录」续期凭证（lib/services/resume-token.ts）：只存哈希，一次一换
  db.exec(`
    CREATE TABLE IF NOT EXISTS resume_tokens (
      hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}
