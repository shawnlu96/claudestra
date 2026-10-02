/**
 * Merge queue order (i28-MQ2): once the project merge lock frees, the auto tick walks merge-stage cards first, oldest merge entry
 * first, so the first card whose plan the ledger accepts is the one that has waited longest and can merge. Entry = the latest
 * `stage → merge` event (the same seq planIntent counts a round from): a card the merge gate bounced back re-queues at the tail.
 * Every other card keeps its finishFirst + rotation order. `ledger merge-queue` lists through the same function.
 */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";

export interface MergeEntry { seq: number; ts: number }

/** The latest event that moved this card into merge; null when the ledger has none (a hand-edited row). */
export function mergeEntry(db: Database, taskId: string): MergeEntry | null {
  return db.query(`SELECT seq, ts FROM events WHERE target = ? AND kind = 'stage' AND json_extract(data, '$.to') = 'merge'
    ORDER BY seq DESC LIMIT 1`).get(taskId) as MergeEntry | null;
}

/** Merge-stage cards first by entry seq (no entry event = last of them, stable); the rest untouched, in their given order. */
export function mergeFirst<T extends { taskId: string }>(db: Database, cards: readonly T[]): T[] {
  const merging = cards.flatMap((card, i) => getTask(db, card.taskId)?.stage === "merge"
    ? [{ card, i, seq: mergeEntry(db, card.taskId)?.seq ?? Number.MAX_SAFE_INTEGER }] : []);
  const picked = new Set(merging.map((m) => m.i));
  return [...merging.sort((a, b) => a.seq - b.seq || a.i - b.i).map((m) => m.card), ...cards.filter((_, i) => !picked.has(i))];
}
