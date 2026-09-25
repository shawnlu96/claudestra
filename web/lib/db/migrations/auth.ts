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
  // 「记住登录」续期凭证已撤掉（git log -S resume_tokens）：删表，手机本地存储里残留的凭证随之彻底作废
  db.exec("DROP TABLE IF EXISTS resume_tokens");
}
