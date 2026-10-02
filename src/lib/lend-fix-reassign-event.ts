/**
 * Ledger records of automatic fix reassignment, read by the planner, the order core, the tick and the PR close step.
 * Plain SQL / event scans and no lend imports: ledger-lend-lease.ts imports this, so it cannot import back.
 */
import type { Database } from "bun:sqlite";

export const FIX_RELAY_OP = "fix_relay";
export const FIX_RELAY_CLOSED_OP = "fix_relay_closed";
/** Start / end of one stretch in which the write-lease holder could not take the fix; the threshold is measured from its start. */
export const FIX_LEASE_WAIT_OP = "fix_lease_wait";
/** The planner's wait code while that stretch lasts; any other decision ends it. */
export const FIX_LEASE_WAIT_CODE = "fix_lease_wait";
/** Marks a relay refused because the old PR branch moved past the ledger head; the planner hands such a card to PM. */
export const RELAY_DRIFT = "旧 PR 分支的远端 head 与台账不符";
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

type Ev = { seq: number; ts: number; kind: string; data: Record<string, unknown> };

/** The open holder-wait stretch after `since` (the fix stage's entry): its start event, or null when none is open. */
export function leaseWaitOpen<E extends Ev>(events: readonly E[], since: number): E | null {
  const last = events.findLast((e) => e.seq > since && e.kind === "scheduler" && e.data.op === FIX_LEASE_WAIT_OP);
  return last?.data.state === "start" ? last : null;
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
