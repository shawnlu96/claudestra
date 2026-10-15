/**
 * Read side of the repository owner's review bookings (RRL-1): event keys, the card a push belongs to, the P1 lookup by head the
 * bounce step uses, and the notices still owed to PM. No writes here, so the bridge hook and the pass step can use it without
 * reaching the ledger writers (remote-review-ledger.ts). tests/remote-review-intake-ledger.test.ts.
 */
import type { Database } from "bun:sqlite";
import { prCoordinates } from "./card-repo.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listTasks } from "./ledger-store.js";
import type { RemoteReview } from "./remote-review-parse.js";
import type { SchedulerConfig } from "./scheduler-config.js";

export const REMOTE_REVIEW_OP = "remote_review";
export const NOTIFIED_OP = "remote_review_notified";

/** Projects whose scheduler.json names this peer as the repository owner. */
export const handoffProjects = (cfg: SchedulerConfig, peer: string): string[] =>
  Object.entries(cfg.projects).filter(([, p]) => p.handoffPeer === peer).map(([id]) => id);

/** The one card of these projects whose PR has this number; none or several = null (the push then goes to PM as before). */
export function matchRemoteCard(db: Database, projects: readonly string[], number: number): LedgerTask | null {
  const hits = projects.flatMap((p) => listTasks(db, p)).filter((t) => prCoordinates(t.pr)?.pr === number);
  return hits.length === 1 ? hits[0]! : null;
}

const isRemote = (e: LedgerEvent): boolean => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === REMOTE_REVIEW_OP;

/** The latest remote review with P1 for this head (prefix match), whatever head the card had when it arrived. */
export function remoteP1At(events: readonly LedgerEvent[], head: string | null): LedgerEvent | null {
  if (!head) return null;
  return events.findLast((e) => isRemote(e) && Number(e.data.p1) > 0 && typeof e.data.head12 === "string" && head.toLowerCase().startsWith(e.data.head12)) ?? null;
}

export const remoteReviewKey = (taskId: string, r: Pick<RemoteReview, "reportId" | "head12">): string =>
  `scheduler:${REMOTE_REVIEW_OP}:${taskId}:${r.reportId}:${r.head12}`;
export const notifiedKey = (seq: number): string => `scheduler:${NOTIFIED_OP}:${seq}`;

/** remote_review events of this project with a notice PM has not been marked as having received (a range on the dedupKey index, no scan). */
export function unsentRemoteNotices(db: Database, project: string): { taskId: string; seq: number; text: string }[] {
  const lo = `scheduler:${REMOTE_REVIEW_OP}:`, hi = `scheduler:${REMOTE_REVIEW_OP};`;
  const rows = db.query(`SELECT seq, target, json_extract(data, '$.notice') AS notice FROM events WHERE dedupKey >= ? AND dedupKey < ?
    AND project = ? AND kind = 'scheduler' AND actor = 'scheduler' AND json_extract(data, '$.notice') IS NOT NULL ORDER BY seq`)
    .all(lo, hi, project) as { seq: number; target: string; notice: string }[];
  return rows.filter((x) => !getEventByDedup(db, notifiedKey(x.seq))).map((x) => ({ taskId: x.target, seq: x.seq, text: x.notice }));
}
