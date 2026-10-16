/**
 * REPLFAIR1: the order a center-replica sync reads feature details in (pure). The center rate-limits by IP, so a round may be
 * cut short by a 429; the ids read first are the ones that make progress.
 * - Center features with no local replica yet (new) come first, in the center list's order: a newly published feature can no
 *   longer sit behind the already-landed ones forever.
 * - Landed replicas follow, least recently synced first (syncedAt), ties by lastErrorAt (none = oldest), then list order. Every
 *   landed replica is still read (center revisions must reach it); a round cut short leaves the unread ones with the oldest
 *   syncedAt, so the next round starts with them.
 * tests/shared-ledger-center-replica-order.test.ts.
 */

/** Minimum gap between two detail reads in one sync run (same order as the mirror loop's pacing). */
export const REPLICA_DETAIL_GAP_MS = 600;

export interface ReplicaOrderEntry { syncedAt: number; lastErrorAt: number | null }

export function orderReplicaIds(ids: readonly string[], replicas: Readonly<Record<string, ReplicaOrderEntry | undefined>>): string[] {
  const fresh = ids.filter((id) => !replicas[id]);
  const landed = ids.map((id, i) => ({ id, i, e: replicas[id] })).filter((x): x is { id: string; i: number; e: ReplicaOrderEntry } => !!x.e);
  landed.sort((a, b) => a.e.syncedAt - b.e.syncedAt || (a.e.lastErrorAt ?? 0) - (b.e.lastErrorAt ?? 0) || a.i - b.i);
  return [...fresh, ...landed.map((x) => x.id)];
}

/** Waits until `gapMs` has passed since `last` (null = no earlier read: no wait); returns the time the next read starts. */
export async function paceDetailRead(last: number | null, now: () => number, sleep: (ms: number) => Promise<void>, gapMs = REPLICA_DETAIL_GAP_MS): Promise<number> {
  if (last !== null) {
    const wait = last + gapMs - now();
    if (wait > 0) await sleep(wait);
  }
  return now();
}
