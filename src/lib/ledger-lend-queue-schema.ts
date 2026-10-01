import type { Database } from "bun:sqlite";

/** Tail migration is repeatable without changing existing order or queue rows. */
export function LEND_QUEUE_SCHEMA(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS lend_push_queue (
    orderId TEXT PRIMARY KEY REFERENCES lend_orders(orderId), queuedAt INTEGER, pushedAt INTEGER,
    notified INTEGER NOT NULL DEFAULT 0, overdue INTEGER NOT NULL DEFAULT 0)`);
}
