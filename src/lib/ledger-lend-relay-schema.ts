/**
 * lend_relays / lend_relay_marks（i28-RS1，逻辑在 ledger-lend-relay.ts）：借出去的写 / 修单持单期间要转给出借执行者的补充，和每单的基线。
 * 只做加法，可重跑。单独成文件：ledger-store.ts 要在模块求值时读表名，不能和读台账的逻辑互相 import。
 */
import type { Database } from "bun:sqlite";

const RELAY_STATES = ["pending", "sending", "sent", "refused", "dropped", "failed", "unknown"] as const;
export type RelayState = (typeof RELAY_STATES)[number];

export function LEND_RELAY_SCHEMA(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS lend_relays (
    key TEXT PRIMARY KEY, orderId TEXT NOT NULL, taskId TEXT NOT NULL, project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spec','answer','note')), target TEXT NOT NULL, text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${RELAY_STATES.map((s) => `'${s}'`).join(",")})), reason TEXT, tries INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
  db.run("CREATE INDEX IF NOT EXISTS lend_relays_state ON lend_relays(state)");
  db.run(`CREATE TABLE IF NOT EXISTS lend_relay_marks (
    orderId TEXT PRIMARY KEY, specBytes INTEGER NOT NULL, answerSeq INTEGER NOT NULL)`);
}
export const LEND_RELAY_TABLES = ["lend_relays", "lend_relay_marks"] as const;
