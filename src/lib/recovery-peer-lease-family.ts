/**
 * dispatch-recovery-PEERLEASE1 · which family the card's fix author is after a peer author handover (recovery-peer-lease-handover.ts).
 * The auto snapshot normally takes the author family from the head a peer delivered (remoteHeadFamily), so an old Claude delivery
 * would overrule this machine's Codex fix author and the author session gate would refuse it. With a complete handover on record
 * for the card's current spec, round and head — and while that old head is still the newest delivery — the fix author is the frozen
 * runtime until a local binding exists, then the binding's family only if it confirms the frozen runtime (a different one = no
 * override, the gate refuses as before). The old head's delivery family is left alone (remoteAuthorFamily); after this machine
 * delivers, remoteHeadFamily is null and the workflow's author family (written by the local author step) decides review as usual.
 * Plain SQL / event reads, no switch, lend or session imports (autoSnapshot and sessions sit below them); the launch's on-only read
 * is recovery-peer-lease-runtime.ts. tests/recovery-peer-lease-family.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { WorkerRef } from "./scheduler-plan.js";

export const PEER_HANDOVER_OP = "peer_author_handover";

interface HandoverRow { seq: number; ts: number; data: string }

/** The newest handover event of the card, or null. */
function lastHandover(db: Database, taskId: string): { seq: number; ts: number; data: Record<string, unknown> } | null {
  const r = db.query(`SELECT seq, ts, data FROM events WHERE target = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = ?
    ORDER BY seq DESC LIMIT 1`).get(taskId, PEER_HANDOVER_OP) as HandoverRow | null;
  return r ? { seq: r.seq, ts: r.ts, data: JSON.parse(r.data) as Record<string, unknown> } : null;
}

type Card = { id: string; specRev: number; round: number; headSHA: string | null; stage: string };

/** The card's handover for its current spec, round and head while the old head is still the newest delivery, with its frozen runtime. */
function currentHandover(db: Database, task: Card): { sessionId: unknown; runtime: AuthorFamily } | null {
  if (task.stage !== "fix" || !task.headSHA) return null;
  const h = lastHandover(db, task.id);
  if (!h || h.data.specRev !== task.specRev || h.data.round !== task.round || h.data.head !== task.headSHA) return null;
  const runtime = h.data.runtime === "claude" || h.data.runtime === "codex" ? h.data.runtime : null;
  if (!runtime) return null;
  const later = db.query("SELECT 1 FROM events WHERE target = ? AND kind = 'deliver' AND seq > ? LIMIT 1").get(task.id, h.seq);
  return later ? null : { sessionId: h.data.sessionId, runtime };
}

/**
 * The fix author's family under a handover, or null (no handover, or it does not apply: other spec / round / head, a newer delivery
 * since, a local binding that contradicts the frozen runtime). `author` is the card's current binding as the snapshot reads it.
 */
export function handoverAuthorFamily(db: Database, task: Card, author: WorkerRef | null): AuthorFamily | null {
  const h = currentHandover(db, task);
  if (!h) return null;
  if (!author) return h.runtime;
  if (author.source !== "local" || author.sessionId === h.sessionId) return null;
  return author.family === h.runtime ? h.runtime : null;
}

/** The frozen runtime a bound local author contradicts (recovery-peer-lease-tick.ts notes it once), or null. */
export function handoverRuntimeDrift(db: Database, task: Card, author: WorkerRef | null): { frozen: AuthorFamily; bound: AuthorFamily } | null {
  const h = currentHandover(db, task);
  return h && author?.source === "local" && author.sessionId !== h.sessionId && author.family !== h.runtime ? { frozen: h.runtime, bound: author.family } : null;
}

/** The runtime the card's current handover froze, regardless of the switch (recovery-peer-lease-runtime.ts gates it on on), or null. */
export const handoverFrozenRuntime = (db: Database, task: Card): AuthorFamily | null => currentHandover(db, task)?.runtime ?? null;

/** A binding a peer author handover retired is history, not the role's current binding: the local author binds as a first one. */
export function unlessHandedOver<R extends { taskId: string; sessionId: string; state: string; transport: string }>(db: Database, row: R | null): R | null {
  if (!row || row.state !== "retired" || row.transport !== "peer") return row;
  const h = lastHandover(db, row.taskId);
  return h?.data.sessionId === row.sessionId ? null : row;
}
