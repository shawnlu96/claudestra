/**
 * The relay event of an automatic fix reassignment (i28-RA1), read back by the planner, the order core and the PR close step.
 * Plain SQL over events / lend_orders and no lend imports: ledger-lend-lease.ts imports this, so it cannot import back.
 * tests/lend-fix-reassign.test.ts.
 */
import type { Database } from "bun:sqlite";

export const FIX_RELAY_OP = "fix_relay";
export const FIX_RELAY_CLOSED_OP = "fix_relay_closed";
/** At most one automatic reassignment per card in this window; the second goes to PM. */
export const FIX_RELAY_WINDOW_MS = 60 * 60_000;

export interface FixRelay {
  seq: number; ts: number; from: string; to: string; head: string; round: number; specRev: number;
  fromBranch: string; toBranch: string; repo: string; oldPr: number | null; reason: string;
}

const toRelay = (r: { seq: number; ts: number; data: string }): FixRelay => ({ seq: r.seq, ts: r.ts, ...(JSON.parse(r.data) as Omit<FixRelay, "seq" | "ts">) });

export function fixRelays(db: Database, taskId: string): FixRelay[] {
  return (db.query(`SELECT seq, ts, data FROM events WHERE target = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = ? ORDER BY seq`)
    .all(taskId, FIX_RELAY_OP) as { seq: number; ts: number; data: string }[]).map(toRelay);
}

/**
 * The peer a fix order may go to without holding the write lease: the newest relay of this round and head, while no lend order
 * was put out after it (the relay order itself holds the new lease from then on). null = no relay entry.
 */
export function relayTarget(db: Database, task: { id: string; round: number; specRev: number; headSHA: string | null }): string | null {
  const r = fixRelays(db, task.id).at(-1);
  if (!r || r.round !== task.round || r.specRev !== task.specRev || r.head !== task.headSHA) return null;
  const later = db.query("SELECT 1 FROM lend_orders WHERE taskId = ? AND createdAt >= ? LIMIT 1").get(task.id, r.ts);
  return later ? null : r.to;
}
