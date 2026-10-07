/**
 * Keep a card's held file locks (scheduler_resources scope='card') in step with its declared scope: rewrite_dag changing a bound
 * node's fileGlobs (ledger-dag-write.ts), and the merge handoff narrowing to the PR's net diff (scheduler-merge-handoff.ts). Without this the
 * DAG and lanes said "free" while the old locks kept blocking other cards. tests/ledger-scheduler-lease-sync.test.ts.
 */
import { Database } from "bun:sqlite";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";

export interface FileLock { resource: string; intentId: string; acquiredAt: number }

const hasResources = (db: Database): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_resources'").get();
/** Bare path / glob resources only: slot:, task:, merge: and any future namespaced kind are never touched here. */
export const isFileResource = (r: string): boolean => !r.includes(":") && resourceKey(r) === r;

export function cardFileLocks(db: Database, taskId: string): FileLock[] {
  if (!hasResources(db)) return [];
  const rows = db.query("SELECT resource, intentId, acquiredAt FROM scheduler_resources WHERE taskId = ? AND scope = 'card' ORDER BY resource")
    .all(taskId) as FileLock[];
  return rows.filter((r) => isFileResource(r.resource));
}

/** Every path `inner` can name is also named by `outer` (the scheduler's prefix-before-* glob reading, resourcesOverlap). */
export function coveredBy(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  if (!outer.includes("*")) return false;
  const prefix = (s: string) => s.slice(0, s.indexOf("*") < 0 ? s.length : s.indexOf("*"));
  return prefix(inner).startsWith(prefix(outer));
}

export const globKeys = (globs: readonly string[]): string[] => [...new Set(globs.map((g) => resourceKey(g)).filter((k): k is string => !!k))].sort();

/**
 * Replace the card's held file locks with `next`, in the caller's transaction. Added locks must not overlap another card's
 * resources (conflict, nothing written); `anchor` is the held lock whose intent the new row keeps (the dispatch that took it).
 */
export function replaceCardFileLocks(db: Database, task: LedgerTask, held: readonly FileLock[], next: readonly string[], now: number): void {
  const add = next.filter((r) => !held.some((h) => h.resource === r));
  const others = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ? AND taskId <> ?").all(task.project, task.id) as
    { resource: string; taskId: string }[];
  for (const r of add) {
    const used = others.find((o) => isFileResource(o.resource) && resourcesOverlap(r, o.resource));
    if (used) throw new LedgerError("conflict", `${task.id} 要加锁 ${r}，和 ${used.taskId} 拿着的 ${used.resource} 重叠：先等它放锁或缩小范围`,
      { resource: r, held: used.resource, taskId: used.taskId });
  }
  const anchor = [...held].sort((a, b) => b.acquiredAt - a.acquiredAt)[0];
  for (const h of held) {
    if (!next.includes(h.resource)) db.query("DELETE FROM scheduler_resources WHERE project = ? AND taskId = ? AND resource = ? AND scope = 'card'")
      .run(task.project, task.id, h.resource);
  }
  for (const r of add) {
    db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES (?, ?, ?, ?, ?, 'card')")
      .run(task.project, r, task.id, anchor!.intentId, now);
  }
}

/**
 * The locks a card should hold once its globs go from `oldGlobs` to `newGlobs`: a held lock still inside a new glob stays as it
 * is (a handoff-narrowed file stays narrowed); a dropped one gives way to the new globs it overlapped; a glob that is genuinely
 * new is taken too. A card holding no file locks takes nothing now — its next dispatch acquires (and waits) as usual.
 */
export function syncedLocks(held: readonly FileLock[], oldGlobs: readonly string[], newGlobs: readonly string[]): string[] {
  if (!held.length) return [];
  const next = globKeys(newGlobs), before = new Set(globKeys(oldGlobs));
  const kept = held.map((h) => h.resource).filter((r) => next.some((g) => coveredBy(r, g)));
  const dropped = held.map((h) => h.resource).filter((r) => !kept.includes(r));
  const taken = next.filter((g) => !kept.some((r) => coveredBy(g, r)) && (dropped.some((r) => resourcesOverlap(g, r)) || !before.has(g)));
  return [...new Set([...kept, ...taken])].sort();
}

/**
 * The scheduler daemon's pass reads through a query_only connection (ledger-read.ts); its few direct lock writes open a write
 * connection on the same file for the one transaction, like the finished-card probe (ledger-scheduler-lease-finished.ts).
 */
const WRITER_BUSY_MS = 5000;
export function withLedgerWriter<T>(db: Database, fn: (writer: Database) => T): T {
  const memory = !db.filename || db.filename === ":memory:";
  const writer = memory ? db : new Database(db.filename, { readwrite: true, create: false });
  // same wait as every ledger connection (ledger-store.ts): a CLI write holding the lock for a moment is not a failure
  if (!memory) writer.exec(`PRAGMA busy_timeout = ${WRITER_BUSY_MS}`);
  try { return fn(writer); } finally { if (!memory) writer.close(); }
}

/** Open dispatch of the card: a writer that may still be editing files of its old scope. */
export const openDispatch = (db: Database, taskId: string) => db.query(`SELECT id, status FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch'
  AND status IN ('pending','submitted','unknown') LIMIT 1`).get(taskId) as { id: string; status: string } | null;
