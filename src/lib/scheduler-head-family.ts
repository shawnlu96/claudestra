/**
 * Family that wrote a card's current head when a lender did (i28-W9): the newest answered write / fix lend order whose
 * delivery event recorded exactly this head. null = the head is not a lend delivery and the workflow's authorFamily
 * stands. The auto snapshot, the reviewer session bind, the verdict check and both merge gates read this one function,
 * so a Codex-written card is never Codex-reviewed. A plain SQL read with no lend imports: sessions / merge sit below the
 * lend modules, and importing them here would close a cycle. tests/scheduler-write-remote.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";

export function remoteHeadFamily(db: Database, task: { id: string; headSHA: string | null }): AuthorFamily | null {
  if (!task.headSHA || !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return null;
  const r = db.query(`SELECT o.family FROM lend_orders AS o JOIN events AS e ON e.seq = o.eventSeq WHERE o.taskId = ? AND o.step IN ('write','fix')
    AND o.status = 'done' AND e.kind = 'deliver' AND json_extract(e.data, '$.headSHA') = ? ORDER BY o.createdAt DESC LIMIT 1`)
    .get(task.id, task.headSHA) as { family: AuthorFamily } | null;
  return r?.family ?? null;
}
