/**
 * Push TTL (lend protocol v2, docs/design/remote-capacity.md §8.2): an order pooled for a peer that speaks v2 is pushed to it,
 * and a push is only a notice — so a lost push, a lost answer or a lender that accepted and then went quiet must not leave the
 * order hanging. Not acknowledged within PUSH_ACK_TTL_MS of the offer, or acknowledged but unclaimed PUSH_CLAIM_TTL_MS later
 * → withdrawn by the same CAS the scheduler uses (withdrawPooledLend: loses cleanly to a claim that got there first).
 * Acknowledgement is lend_orders.seenAt, set once (a repeated ack never extends it). sweepLend calls this inside its
 * transaction; the withdraw is passed in so this file does not import ledger-lend.ts. tests/ledger-lend-peers-ttl.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";

export const PUSH_ACK_TTL_MS = 2 * 60_000;
export const PUSH_CLAIM_TTL_MS = 3 * 60_000;

/** Bound with pushTtlArgs(now). */
const PUSH_TTL_SQL = `status = 'pooled' AND peer IN (SELECT peer FROM lend_peers WHERE proto >= 2)
  AND ((seenAt IS NULL AND createdAt < ?) OR (seenAt IS NOT NULL AND seenAt < ?))`;
const pushTtlArgs = (now: number): [number, number] => [now - PUSH_ACK_TTL_MS, now - PUSH_CLAIM_TTL_MS];

const hasPeersTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_peers'").get();

interface Due { orderId: string; taskId: string; project: string; peer: string; seenAt: number | null }

export function pushTtlDue(db: Database, now: number): Due[] {
  if (!hasPeersTable(db)) return [];
  return db.query(`SELECT orderId, taskId, project, peer, seenAt FROM lend_orders WHERE ${PUSH_TTL_SQL} ORDER BY createdAt`).all(...pushTtlArgs(now)) as Due[];
}

/** Same shape as ledger-lend.ts LendNotice (not imported: ledger-lend.ts imports this file). */
type Notice = { project: string; taskId: string; text: string };

/**
 * Withdraw every due order; auto cards need no word (the scheduler's pool sync sees the cancel and re-places the round),
 * a PM-offered one tells its PM.
 */

export function sweepPushTtl(db: Database, now: number, withdraw: (orderId: string, reason: string) => boolean): Notice[] {
  return pushTtlDue(db, now).flatMap((d) => {
    const why = d.seenAt === null ? `推送 ${PUSH_ACK_TTL_MS / 60_000} 分钟没收到 ${d.peer} 的确认`
      : `${d.peer} 确认收到后 ${PUSH_CLAIM_TTL_MS / 60_000} 分钟没领`;
    if (!withdraw(d.orderId, `推送超时撤回：${why}`)) return [];
    if (getWorkflow(db, d.taskId)?.mode === "auto") return [];
    return [{ project: d.project, taskId: d.taskId, text: `出借单 ${d.orderId}（${d.taskId}）${why}，已撤回；要再借就 ledger lend-offer ${d.taskId}` }];
  });
}

/** Mark pushed orders as acknowledged (first ack only) — only this peer's, only while still pooled. */
export function ackPushed(db: Database, peer: string, orderIds: string[], now: number): number {
  const q = db.prepare("UPDATE lend_orders SET seenAt = ? WHERE orderId = ? AND peer = ? AND status = 'pooled' AND seenAt IS NULL");
  return orderIds.reduce((n, id) => n + q.run(now, id, peer).changes, 0);
}
