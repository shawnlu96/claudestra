/** Read-only audit hydration. No task head is rewritten and no caller receives an unverified recovery basis. */
import type { Database } from "bun:sqlite";
import type { LendOrder } from "./ledger-lend.js";
import type { ReborrowFacts } from "./lend-reborrow-facts.js";
import type { ReborrowSource } from "./lend-reborrow-source.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { readReborrowBinding } from "./lend-reborrow-marker.js";

export interface ReborrowBasis { ledgerHead: string | null; reclaimSeq: number; previousOrderId: string }

/** null marks a damaged or not-yet-committed recovery; cardMoved must reject it, including during canonical construction. */
export function readReborrowBasis(db: Database, o: LendOrder): ReborrowBasis | null | undefined {
  const events = listEvents(db, { project: o.project, target: o.taskId });
  const matches = events.filter((e) => {
    const l = e.data.lend as { op?: string; orderId?: string } | undefined;
    return l?.op === "write_reborrow" && l.orderId === o.orderId;
  });
  let b;
  try { b = readReborrowBinding(o.wire.acceptance); } catch { return null; } // Invalid reserved text is a refusal, never an ordinary order.
  if (!b) return matches.length ? null : undefined;
  if (matches.length !== 1) return null;
  const e = matches[0], l = e.data.lend as {
    facts: ReborrowFacts; reclaim: ReborrowFacts["reclaim"]; previousLease: ReborrowFacts["lease"]; source: ReborrowSource; ledgerHead: string | null; previousOrderId: string; head: string;
  };
  const f = l.facts, s = l.source;
  if (!f?.task || !f.previous || !f.lease || !f.reclaim || !s) return null;
  if (JSON.stringify(l.reclaim) !== JSON.stringify(f.reclaim) || JSON.stringify(l.previousLease) !== JSON.stringify(f.lease)) return null;
  if (getEventByDedup(db, `lend-reborrow:${o.taskId}:${b.reclaimSeq}`)?.seq !== e.seq) return null;
  const reclaim = events.find((x) => x.seq === b.reclaimSeq);
  const link = reclaim?.data.lend as { op?: string; peer?: string; cancelled?: string; orderId?: string } | undefined;
  if (link?.op !== "reclaim" || link.peer !== o.peer || (link.cancelled && (link.cancelled !== b.orderId || link.orderId !== b.orderId)) ||
    f.lease.updatedAt !== reclaim?.ts || !f.lease.reason?.startsWith("PM 收回：")) return null;
  const old = db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(b.orderId) as Record<string, unknown> | null;
  if (e.kind !== "note" || e.actor !== o.createdBy || JSON.stringify(reclaim) !== JSON.stringify(f.reclaim) ||
    f.reclaim.seq !== b.reclaimSeq || f.previous.orderId !== b.orderId || f.previous.leaseGen !== b.gen ||
    !old || !["done", "released", "cancelled"].includes(String(old.status)) || old.leaseGen !== b.gen || old.peer !== o.peer ||
    old.family !== o.family || old.repo !== o.repo || old.branch !== o.branch ||
    l.previousOrderId !== b.orderId || o.supersedes !== b.orderId || f.task.id !== o.taskId || f.task.project !== o.project ||
    f.task.specRev !== o.specRev || f.task.round !== o.round || f.task.headSHA !== l.ledgerHead || f.family !== o.family ||
    f.lease.peer !== o.peer || f.lease.repo !== o.repo || f.lease.branch !== o.branch || f.lease.state !== "ended" ||
    s.peer !== o.peer || s.fp !== f.lease.fp || s.repo !== o.repo || s.branch !== o.branch || s.remoteHead !== o.head || l.head !== o.head ||
    o.base !== "main" || o.pr !== (s.pr?.number ?? null) || (s.pr && (s.pr.base !== "main" || s.pr.head !== o.head)) ||
    o.wire.orderId !== o.orderId || o.wire.head !== o.head || o.wire.repo !== o.repo || o.wire.pr !== o.pr ||
    o.step !== (f.task.stage === "build" ? "write" : "fix")) return null;
  return { ledgerHead: l.ledgerHead, reclaimSeq: b.reclaimSeq, previousOrderId: b.orderId };
}
