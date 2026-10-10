/**
 * Ledger proof that a retired agent's checkout may be touched (agent-lifecycle-cleanup.ts asks before anything is copied and again right
 * before anything moves): its card has no write dispatch still open (pending / submitted / unknown effect) and holds no scheduler
 * resource (card write lease), and a retry's pending row is still that debt (agent + original session + createdAt, still pending).
 * Any read error, including a missing ledger, is a refusal: absence cannot prove that a write lease was released.
 */
import { Database } from "bun:sqlite";
import { LEDGER_PATH } from "./ledger-store.js";

export interface HoldSubject { agent: string; taskId?: string | null; sessionId?: string; regAt?: number; rule?: string }

const hasTable = (db: Database, t: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/** Why the checkout must stay as it is now; null = nothing in the ledger holds it. */
function writeHold(db: Database, s: HoldSubject): string | null {
  if (s.rule === "cleanup_retry") {
    const row = hasTable(db, "worker_agents") && db.query(`SELECT 1 FROM worker_agents WHERE agent = ? AND sessionId = ? AND createdAt = ?
      AND state = 'active' AND reason LIKE 'cleanup_pending:%'`).get(s.agent, s.sessionId ?? "", s.regAt ?? -1);
    if (!row) return `待补清登记（${s.agent} / ${s.sessionId ?? "?"} / ${s.regAt ?? "?"}）已结清、退休或重开，核不上原登记，不动`;
  }
  if (!s.taskId) return null;
  const open = hasTable(db, "scheduler_intents") ? db.query(`SELECT id, node, status FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch'
    AND node IN ('write','fix') AND status IN ('pending','submitted','unknown') ORDER BY id LIMIT 1`).get(s.taskId) as { id: string; node: string; status: string } | null : null;
  if (open) return `卡 ${s.taskId} 还有没结清的写派单 ${open.id}（${open.node} / ${open.status}），写方效果未定，不动`;
  const lease = hasTable(db, "scheduler_resources") ? db.query("SELECT resource, scope FROM scheduler_resources WHERE taskId = ? ORDER BY resource LIMIT 1")
    .get(s.taskId) as { resource: string; scope: string } | null : null;
  return lease ? `卡 ${s.taskId} 还持有调度资源 ${lease.resource}（${lease.scope} 写租约），不动` : null;
}

/** writeHold read from the ledger file (read-only, its own short-lived connection); a read error is the reason. */
export function readWriteHold(path: string | undefined, s: HoldSubject): string | null {
  const p = path ?? LEDGER_PATH;
  let db: Database | null = null;
  try {
    db = new Database(p, { readonly: true });
    return writeHold(db, s);
  } catch (e) {
    return `台账读不了，核不了写派单 / 写租约，不动：${(e as Error).message}`;
  } finally { db?.close(); }
}
