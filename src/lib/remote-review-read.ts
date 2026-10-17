/**
 * Read side of the repository owner's review bookings (RRL-1): event keys, the card a push belongs to, the P1 lookup by head the
 * bounce step uses, and the notices still owed to PM. No writes here, so the bridge hook and the pass step can use it without
 * reaching the ledger writers (remote-review-ledger.ts). tests/remote-review-intake-ledger.test.ts.
 */
import type { Database } from "bun:sqlite";
import { fullRemoteHead, remoteIdentityKey, sameRemoteHead, sameRemotePr, type RemoteIdentity } from "./remote-review-identity.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listTasks } from "./ledger-store.js";
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

/** Every remote_review* event of this project, by their shared prefix on the dedupKey index: no table scan. */
export function remoteRows(db: Database, project: string): { seq: number; target: string; data: string }[] {
  return db.query(`SELECT seq, target, data FROM events WHERE dedupKey >= ? AND dedupKey < ? AND project = ? AND kind = 'scheduler'
    AND actor = 'scheduler' ORDER BY seq`).all(`scheduler:${REMOTE_REVIEW_OP}`, "scheduler:remote_reviex", project) as { seq: number; target: string; data: string }[];
}

/** Notices (on a booking or a late application) PM has not been marked as having received. */
export function unsentRemoteNotices(db: Database, project: string): { taskId: string; seq: number; text: string }[] {
  return remoteRows(db, project).map((x) => ({ ...x, notice: (JSON.parse(x.data) as { notice?: unknown }).notice }))
    .filter((x) => typeof x.notice === "string" && !getEventByDedup(db, notifiedKey(x.seq)))
    .map((x) => ({ taskId: x.target, seq: x.seq, text: x.notice as string }));
}

/** Bookings that did not match at intake, not applied yet, whose card (not finished) has now reached that head. */
export function lateRemoteMatches(db: Database, project: string): { taskId: string; seq: number }[] {
  return remoteRows(db, project).filter((x) => {
    const d = JSON.parse(x.data) as RemoteIdentity & { op?: string; matched?: boolean };
    if (d.op !== REMOTE_REVIEW_OP || d.matched !== false || typeof d.repo !== "string" || getEventByDedup(db, appliedKey(x.seq))) return false;
    const task = getTask(db, x.target);
    return !!task && sameRemotePr(task.pr, d) && !TERMINAL_STAGES.includes(task.stage) && !!remoteHeadMatch(db, task, d.fullHead);
  }).map((x) => ({ taskId: x.target, seq: x.seq }));
}
