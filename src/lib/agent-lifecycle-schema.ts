/**
 * worker_agents（LIFE1，读写在 agent-lifecycle-store.ts）：卡 worker 的登记表，接在 ledger-store.ts LEDGER_MIGRATIONS 末尾。
 * 迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，每步可重跑（IF NOT EXISTS），版本号撞过时整体重跑也走得通。
 */
import type { Database } from "bun:sqlite";

const WORKER_AGENTS_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS worker_agents (
    agent TEXT NOT NULL, sessionId TEXT NOT NULL DEFAULT '', taskId TEXT, role TEXT NOT NULL CHECK (role IN ('author','reviewer','other')),
    createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','retired')),
    retiredAt INTEGER, reason TEXT, PRIMARY KEY (agent, createdAt))`,
  "CREATE INDEX IF NOT EXISTS worker_agents_state ON worker_agents(state, taskId)",
];

export function WORKER_AGENTS_SCHEMA(db: Database): void {
  for (const sql of WORKER_AGENTS_SQL) db.prepare(sql).run();
}

export const WORKER_AGENTS_TABLES = ["worker_agents"] as const;
export const WORKER_AGENTS_COLUMNS: Record<string, readonly string[]> = {
  worker_agents: ["agent", "sessionId", "taskId", "role", "createdBy", "createdAt", "state", "retiredAt", "reason"],
};
export const WORKER_AGENTS_INDEXES: Record<string, readonly string[]> = { worker_agents: ["worker_agents_state"] };
