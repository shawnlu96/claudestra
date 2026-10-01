/**
 * Family that wrote a card's code when a lender did (i28-W9): the card's newest delivery that carried a head, if a done
 * write / fix lend order recorded it. A later local delivery makes it null again (the workflow's authorFamily stands); the
 * merge queue's update-branch moves the head without a delivery and keeps it, since merging main writes no code. The auto
 * snapshot, reviewer bind, verdict check and both merge gates read only this, so a Codex-written card is never Codex-reviewed.
 * Plain SQL, no lend imports (sessions / merge sit below the lend modules: a cycle). tests/scheduler-write-remote.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";

export function remoteHeadFamily(db: Database, task: { id: string; project: string; headSHA: string | null }): AuthorFamily | null {
  if (!task.headSHA || !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return null;
  const r = db.query(`SELECT o.family FROM events AS e LEFT JOIN lend_orders AS o ON o.eventSeq = e.seq AND o.taskId = e.target
    AND o.step IN ('write','fix') AND o.status = 'done' WHERE e.project = ? AND e.target = ? AND e.kind = 'deliver'
    AND json_extract(e.data, '$.headSHA') IS NOT NULL ORDER BY e.seq DESC LIMIT 1`).get(task.project, task.id) as { family: AuthorFamily | null } | null;
  return r?.family ?? null;
}
