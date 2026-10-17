/**
 * Read side of the repository owner's review bookings (RRL-1): event keys, the card a push belongs to, the P1 lookup by head the
 * bounce step uses, and the notices still owed to PM. No writes here, so the bridge hook and the pass step can use it without
 * reaching the ledger writers (remote-review-ledger.ts). tests/remote-review-intake-ledger.test.ts.
 */
import type { Database } from "bun:sqlite";
import { fullRemoteHead, remoteIdentityKey, sameRemoteHead, sameRemotePr, type RemoteIdentity } from "./remote-review-identity.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getTask, listTasks } from "./ledger-store.js";
import type { RemoteReview } from "./remote-review-parse.js";
import { REMOTE_REVIEW_OP } from "./remote-review-current.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { handoffOf } from "./scheduler-merge-handoff.js";

export { REMOTE_REVIEW_OP, remoteCurrentAt, remoteP1At } from "./remote-review-current.js";
export const NOTIFIED_OP = "remote_review_notified";
/** A review that did not match the card's head when it arrived, applied once the card reached that head. */
export const APPLIED_OP = "remote_review_applied";

/** Projects whose scheduler.json names this peer as the repository owner. */
export const handoffProjects = (cfg: SchedulerConfig, peer: string): string[] =>
  Object.entries(cfg.projects).filter(([, p]) => p.handoffPeer === peer).map(([id]) => id);

/** The one card of these projects for this repo+PR; none or several = ordinary PM delivery. */
export function matchRemoteCard(db: Database, projects: readonly string[], r: Pick<RemoteIdentity, "repo" | "number">): LedgerTask | null {
  const hits = projects.flatMap((p) => listTasks(db, p)).filter((t) => sameRemotePr(t.pr, r));
  return hits.length === 1 ? hits[0]! : null;
}

/** Exact full SHA only: the card's head, or in merge the PR head the handoff follows now. */
export function remoteHeadMatch(db: Database, task: LedgerTask, fullHead: unknown): string | null {
  if (!fullRemoteHead(fullHead)) return null;
  const heads = [task.headSHA, task.stage === "merge" ? handoffOf(db, task)?.head : null];
  return heads.find((h): h is string => typeof h === "string" && sameRemoteHead(h, fullHead)) ?? null;
}

export const remoteReviewKey = (taskId: string, r: Pick<RemoteReview, "reportId" | "repo" | "number" | "fullHead">): string =>
  `scheduler:${REMOTE_REVIEW_OP}:${taskId}:${r.reportId}:${remoteIdentityKey(r)}`;
export const notifiedKey = (seq: number): string => `scheduler:${NOTIFIED_OP}:${seq}`;
export const appliedKey = (seq: number): string => `scheduler:${APPLIED_OP}:${seq}`;

/** remote_review* events of this project, by a range on the dedupKey index (all three ops share the prefix): no table scan. `where`
 *  narrows them in SQL, so a round with nothing owed reads no rows; `e` is the event, `?3` the key prefix of its follow-up event.
 *  `+project` keeps the planner off events_project_target, which would walk the project's whole history instead of the range.
 *  The legacy upgrade checklist needs the unfiltered range, including bookings already notified but still awaiting manual action. */
export function remoteRows(db: Database, project: string, where = "1", follow: string | null = null): { seq: number; target: string; data: string }[] {
  const pending = follow === null ? "" : "AND NOT EXISTS (SELECT 1 FROM events f WHERE f.dedupKey = ?3 || e.seq)";
  return db.query(`SELECT seq, target, data FROM events e WHERE dedupKey >= ?1 AND dedupKey < ?2 AND +project = ?4 AND kind = 'scheduler'
    AND actor = 'scheduler' AND ${where} ${pending} ORDER BY seq`)
    .all(`scheduler:${REMOTE_REVIEW_OP}`, "scheduler:remote_reviex", follow, project) as { seq: number; target: string; data: string }[];
}

/** Notices (on a booking or a late application) PM has not been marked as having received. */
export function unsentRemoteNotices(db: Database, project: string): { taskId: string; seq: number; text: string }[] {
  return remoteRows(db, project, "json_type(data, '$.notice') = 'text'", `scheduler:${NOTIFIED_OP}:`)
    .map((x) => ({ taskId: x.target, seq: x.seq, text: (JSON.parse(x.data) as { notice: string }).notice }));
}

/** Bookings that did not match at intake, not applied yet, whose card (not finished) has now reached that head. */
export function lateRemoteMatches(db: Database, project: string): { taskId: string; seq: number }[] {
  return remoteRows(db, project, `json_extract(data, '$.op') = '${REMOTE_REVIEW_OP}' AND json_type(data, '$.matched') = 'false'
    AND json_type(data, '$.repo') = 'text' AND json_type(data, '$.fullHead') = 'text'`, `scheduler:${APPLIED_OP}:`).filter((x) => {
    const d = JSON.parse(x.data) as RemoteIdentity;
    const task = getTask(db, x.target);
    return !!task && sameRemotePr(task.pr, d) && !TERMINAL_STAGES.includes(task.stage) && !!remoteHeadMatch(db, task, d.fullHead);
  }).map((x) => ({ taskId: x.target, seq: x.seq }));
}
