/** Queue state is separate from order timestamps: temporary refusal must not release a write lease or age its next push. */
import type { Database } from "bun:sqlite";
import type { LendFamily } from "./lend-config.js";
import type { LendOrder, LendNotice } from "./ledger-lend.js";
import type { LendPeer } from "./ledger-lend-peers.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { tx } from "./ledger-tx.js";

const WAIT_MS = 2 * 60 * 60_000;
const TEMPORARY = new Set(["no_slot", "paused", "daily", "lender_idle"]);
export const isTemporaryLendRefusal = (code: string): boolean => TEMPORARY.has(code);
interface QueueRow { orderId: string; queuedAt: number | null; pushedAt: number | null; notified: number; overdue: number }
const hasQueue = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE name = 'lend_push_queue' AND type = 'table'").get();

function queueRow(db: Database, orderId: string): QueueRow | null {
  return hasQueue(db) ? db.query("SELECT * FROM lend_push_queue WHERE orderId = ?").get(orderId) as QueueRow | null : null;
}

/** Only a pooled write refusal creates queue state; readers tolerate ledgers predating the migration. */
export function queueRefusal(db: Database, o: LendOrder, code: string, now: number): { notices: LendNotice[] } | null {
  if (o.status !== "pooled" || !TEMPORARY.has(code) || !(o.step === "fix" || (o.step === "write" && getWorkflow(db, o.taskId)?.mode !== "auto"))) return null;
  const prev = queueRow(db, o.orderId);
  db.prepare(`INSERT INTO lend_push_queue (orderId, queuedAt) VALUES (?, ?)
    ON CONFLICT(orderId) DO UPDATE SET queuedAt = COALESCE(lend_push_queue.queuedAt, excluded.queuedAt), pushedAt = NULL`).run(o.orderId, now);
  if (prev?.notified) return { notices: [] };
  db.prepare("UPDATE lend_push_queue SET notified = 1 WHERE orderId = ?").run(o.orderId);
  return { notices: [{ project: o.project, taskId: o.taskId, text: `出借单 ${o.orderId}（${o.taskId}）排队等 ${o.peer} 空位（${code}）；写租约保留` }] };
}

/** Gate only queued orders; ordinary auto offers retain their existing scheduler/withdraw behavior. */
export function queuedPushReady(db: Database, o: { orderId: string; family: LendFamily }, peer: LendPeer, now: number): boolean {
  const q = queueRow(db, o.orderId);
  if (q?.queuedAt == null) return true;
  const pause = peer.paused;
  const paused = pause && pause.until > now && (pause.reason === `${o.family}_quota` || !pause.reason.endsWith("_quota"));
  return !paused && !!peer.grant && peer.grant.ordersLeftToday > 0 && peer.slots[o.family].busy < peer.slots[o.family].total;
}

/** The bridge calls the writer before sending; candidate discovery must remain safe on its read-only connection. */
export function startQueuedPush(db: Database, peer: string, ids: string[], now: number): void {
  tx(db, () => {
    if (!hasQueue(db)) return;
    for (const id of ids) {
      const row = db.query("SELECT 1 FROM lend_orders WHERE orderId = ? AND peer = ? AND status = 'pooled'").get(id, peer);
      if (!row) continue;
      const changed = db.prepare("UPDATE lend_push_queue SET queuedAt = NULL, pushedAt = ? WHERE orderId = ? AND queuedAt IS NOT NULL").run(now, id).changes;
      // A previous ack belongs to the refused attempt; the new attempt must earn its own first acknowledgement.
      if (changed) db.prepare("UPDATE lend_orders SET seenAt = NULL WHERE orderId = ?").run(id);
    }
  });
}

/** Apply to the existing timeout queries: preserve createdAt, but bound an order's age by its latest resumed push. */
export function queueTimeoutDue(db: Database, orderId: string, cutoff: number): boolean {
  const q = queueRow(db, orderId);
  return !q || (q.queuedAt === null && (q.pushedAt === null || q.pushedAt < cutoff));
}

/** Called by the existing sweeper even while TTL withdrawal is suppressed. Deduplication survives process restarts. */
export function sweepQueueNotices(db: Database, now: number): LendNotice[] {
  if (!hasQueue(db)) return [];
  const due = db.query(`SELECT o.orderId, o.project, o.taskId, o.peer FROM lend_push_queue q JOIN lend_orders o USING(orderId)
    WHERE o.status = 'pooled' AND q.queuedAt <= ? AND q.overdue = 0`).all(now - WAIT_MS) as Pick<LendOrder, "orderId" | "project" | "taskId" | "peer">[];
  return due.flatMap((o) => {
    if (!db.prepare("UPDATE lend_push_queue SET overdue = 1 WHERE orderId = ? AND overdue = 0").run(o.orderId).changes) return [];
    return [{ project: o.project, taskId: o.taskId, text: `出借单 ${o.orderId}（${o.taskId}）排队等 ${o.peer} 空位已超过 2 小时；写租约保留，不自动改派` }];
  });
}
