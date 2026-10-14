/** Read-only evidence beneath the session and lending writers, so neither writer imports the other. */
import type { Database } from "bun:sqlite";
import type { WriteLease } from "./ledger-lend-lease.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import type { SchedulerSession } from "./scheduler-sessions.js";
import { createHash } from "node:crypto";

export function lendAuthorBinding(db: Database, id: string): SchedulerSession | null {
  return db.query("SELECT * FROM scheduler_sessions WHERE taskId=? AND role='author' ORDER BY (state!='retired') DESC,createdAt DESC,rowid DESC LIMIT 1")
    .get(id) as SchedulerSession | null;
}
export const lendAuthorLease = (db: Database, id: string): WriteLease | null =>
  db.query("SELECT * FROM lend_write_leases WHERE taskId=?").get(id) as WriteLease | null;
interface Order { orderId: string; step: string; peer: string; worker: string | null; repo: string; branch: string | null; status: string; leaseGen: number }
export function lendAuthorOrders(db: Database, taskId: string): Order[] {
  return db.query("SELECT orderId,step,peer,worker,repo,branch,status,leaseGen FROM lend_orders WHERE taskId=? AND step IN ('write','fix')")
    .all(taskId) as Order[];
}
export function lendAuthorBasis(db: Database, taskId: string): string {
  const rows = db.query("SELECT * FROM lend_orders WHERE taskId=? AND step IN ('write','fix') ORDER BY orderId").all(taskId);
  return createHash("sha256").update(JSON.stringify([lendAuthorLease(db, taskId), rows])).digest("hex");
}

export function retiredLendAuthor(db: Database, task: LedgerTask): boolean {
  const s = lendAuthorBinding(db, task.id), lease = lendAuthorLease(db, task.id);
  const e = listEvents(db, { target: task.id }).findLast(e => e.data.op === "lend_author_retire");
  return !!e && s?.state === "retired" && s.transport === "peer" && s.sessionId === e.data.sessionId
    && s.updatedAt === e.ts && s.agent === e.data.agent && e.data.specRev === task.specRev && e.data.head === task.headSHA
    && lease?.state === "ended" && lease.peer === e.data.peer
    && !lendAuthorOrders(db, task.id).some(o => ["pooled", "claimed", "unknown"].includes(o.status));
}
