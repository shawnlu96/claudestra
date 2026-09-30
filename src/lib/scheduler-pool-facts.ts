/**
 * Ledger reads behind the shared pool (i28-R9): which lend order a pool intent became, when the peer's claim was recorded,
 * who reviewed a pooled round, and the per-card PoolFacts the planner consumes. A pool intent is tied to its order by one
 * scheduler event (`scheduler:<intent>:pool`) written in the offer transaction, so neither table needs a new column.
 * The claim's own note (written by claimLend in its transaction) is the dispatch receipt: it always precedes the verdict,
 * whereas the intent's `submitted` settle only happens on the next scheduler pass. tests/scheduler-pool.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { BorrowEntry } from "./lend-config.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import type { RemotePolicy } from "./scheduler-config.js";
import type { WorkerRef } from "./scheduler-plan.js";
import { POOL_RECIPIENT, type PoolFacts } from "./scheduler-pool-plan.js";

export const poolLinkKey = (intentId: string): string => `scheduler:${intentId}:pool`;
/** The reviewer session id writeLendResult records for an order (ledger-lend-result.ts). */
export const lendSessionId = (peer: string, orderId: string): string => `lend:${peer}:${orderId}`;
/** Written by the scheduler's timeout withdrawal; doctor counts timeouts by it. */
export const POOL_TIMEOUT_REASON = "挂池超时";

const hasLendTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get();

export function poolOrderId(db: Database, intentId: string): string | null {
  const id = getEventByDedup(db, poolLinkKey(intentId))?.data.orderId;
  return typeof id === "string" ? id : null;
}

/** Seq of the peer's claim of this intent's order, or null (never claimed / no order). */
export function poolAckSeq(db: Database, intentId: string): number | null {
  const orderId = poolOrderId(db, intentId);
  if (!orderId) return null;
  const r = db.query(`SELECT seq FROM events WHERE kind = 'note' AND json_extract(data, '$.lend.orderId') = ?
    AND json_extract(data, '$.lend.op') = 'claim' ORDER BY seq LIMIT 1`).get(orderId) as { seq: number } | null;
  return r?.seq ?? null;
}

interface ScheduledOrder { intentId: string; orderId: string; peer: string; family: "claude" | "codex"; status: string; round: number; head: string }

/** Orders the scheduler offered for this card (joined through the pool link event), newest first. */
function scheduledOrders(db: Database, taskId: string): ScheduledOrder[] {
  if (!hasLendTable(db)) return [];
  return db.query(`SELECT json_extract(e.data, '$.id') AS intentId, o.orderId, o.peer, o.family, o.status, o.round, o.head
    FROM lend_orders AS o JOIN events AS e ON e.target = o.taskId AND e.kind = 'scheduler' AND e.dedupKey = 'scheduler:' || json_extract(e.data, '$.id') || ':pool'
    AND json_extract(e.data, '$.orderId') = o.orderId WHERE o.taskId = ? ORDER BY o.createdAt DESC`).all(taskId) as ScheduledOrder[];
}

const reviewerRef = (o: ScheduledOrder, taskId: string): WorkerRef =>
  ({ agent: `${POOL_RECIPIENT}${o.peer}`, sessionId: lendSessionId(o.peer, o.orderId), taskId, family: o.family, source: "peer_claim" });

/** The reviewer a pool intent's answered order recorded (the same strings recordReview got), or null while unanswered. */
export function poolReviewerOf(db: Database, intentId: string, taskId: string): WorkerRef | null {
  const o = scheduledOrders(db, taskId).find((x) => x.intentId === intentId && x.status === "done");
  return o ? reviewerRef(o, taskId) : null;
}

/** The pooled reviewer of the card's current round and head, when that round's verdict came from the pool. */
export function currentPooledReviewer(db: Database, task: LedgerTask): WorkerRef | null {
  const o = scheduledOrders(db, task.id).find((x) => x.status === "done" && x.round === task.round && x.head === task.headSHA);
  return o ? reviewerRef(o, task.id) : null;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` → coordinates for the peer; anything else = the card cannot be pooled. */
export function prCoordinates(pr: string | null): { repo: string; pr: number } | null {
  const m = pr?.match(/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pull\/(\d+)\/?$/);
  return m ? { repo: m[1], pr: Number(m[2]) } : null;
}

export function poolFacts(db: Database, task: LedgerTask, cfg: { remote: RemotePolicy; borrow: readonly BorrowEntry[] }): PoolFacts {
  const localReviewers = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get()
    ? (db.query(`SELECT COUNT(*) AS n FROM scheduler_sessions AS s JOIN tasks AS t ON t.id = s.taskId WHERE t.project = ? AND s.taskId != ?
      AND s.role = 'reviewer' AND s.state = 'active' AND s.transport != 'peer'`).get(task.project, task.id) as { n: number }).n : 0;
  const live = (peer: string): number => hasLendTable(db)
    ? (db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND status IN ('pooled','claimed','unknown')").get(peer) as { n: number }).n : 0;
  const peers = cfg.borrow.filter((b) => b.projects.includes(task.project) && b.roles.includes("review"))
    .map((b) => ({ peer: b.peer, open: live(b.peer), maxOpen: b.maxOpen }));
  const lastPeer = scheduledOrders(db, task.id).find((o) => o.status === "done")?.peer ?? null;
  return { remote: cfg.remote, localReviewers, peers, repo: prCoordinates(task.pr)?.repo ?? null, lastPeer };
}

export interface PoolCounts { pooled: number; claimed: number; done: number; timedOut: number; unknown: number }

/** Doctor's pool row: every order the scheduler offered, by outcome. */
export function poolCounts(db: Database): PoolCounts {
  const out: PoolCounts = { pooled: 0, claimed: 0, done: 0, timedOut: 0, unknown: 0 };
  if (!hasLendTable(db)) return out;
  const rows = db.query(`SELECT o.status, o.reason FROM lend_orders AS o WHERE o.createdBy = 'scheduler'`).all() as { status: string; reason: string | null }[];
  for (const r of rows) {
    if (r.status === "pooled" || r.status === "claimed" || r.status === "done" || r.status === "unknown") out[r.status]++;
    else if (r.status === "cancelled" && r.reason?.startsWith(POOL_TIMEOUT_REASON)) out.timedOut++;
  }
  return out;
}
