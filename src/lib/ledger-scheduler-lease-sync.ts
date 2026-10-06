/**
 * Keep a card's held file locks (scheduler_resources scope='card') in step with its declared scope: rewrite_dag changing a bound
 * node's fileGlobs, and the merge handoff narrowing to the PR's net diff (scheduler-merge-handoff-narrow.ts). Without this the
 * DAG and lanes said "free" while the old locks kept blocking other cards. tests/ledger-scheduler-lease-sync.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";

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

const keys = (globs: readonly string[]): string[] => [...new Set(globs.map((g) => resourceKey(g)).filter((k): k is string => !!k))].sort();

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
  const next = keys(newGlobs), before = new Set(keys(oldGlobs));
  const kept = held.map((h) => h.resource).filter((r) => next.some((g) => coveredBy(r, g)));
  const dropped = held.map((h) => h.resource).filter((r) => !kept.includes(r));
  const taken = next.filter((g) => !kept.some((r) => coveredBy(g, r)) && (dropped.some((r) => resourcesOverlap(g, r)) || !before.has(g)));
  return [...new Set([...kept, ...taken])].sort();
}

const globsOf = (task: LedgerTask): string[] =>
  Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];

/**
 * rewrite_dag changed a bound card's node fileGlobs: write them to the card's extra.fileGlobs (what the scheduler dispatches by)
 * and move its held locks to match, in the rewrite's own transaction. A clash on a lock it would newly take refuses the rewrite.
 */
export function syncCardFileScope(db: Database, ctx: WriteCtx, task: LedgerTask, newGlobs: readonly string[]): void {
  const oldGlobs = globsOf(task);
  if (keys(oldGlobs).join("\n") === keys(newGlobs).join("\n")) return;
  const now = ctx.now ?? Date.now();
  const held = cardFileLocks(db, task.id), next = syncedLocks(held, oldGlobs, newGlobs);
  if (held.length) replaceCardFileLocks(db, task, held, next, now);
  const extra = { ...task.extra, fileGlobs: [...newGlobs] }, rev = task.rev + 1;
  db.prepare("UPDATE tasks SET extra = ?, rev = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(extra), rev, now, task.id);
  insertEvent(db, ctx, { project: task.project, target: task.id, kind: "task", text: "子 DAG 改了文件范围，卡的范围与文件锁同步",
    data: { op: "set", patch: { extra }, rev, fileScope: { from: oldGlobs, to: [...newGlobs], locks: { from: held.map((h) => h.resource), to: next } } } }, false);
}
