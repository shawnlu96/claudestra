/**
 * Read side of the repository owner's review bookings (RRL-1): event keys, the card a push belongs to, the P1 lookup by head the
 * bounce step uses, and the notices still owed to PM. No writes here, so the bridge hook and the pass step can use it without
 * reaching the ledger writers (remote-review-ledger.ts). tests/remote-review-intake-ledger.test.ts.
 */
import type { Database } from "bun:sqlite";
import { prCoordinates } from "./card-repo.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listTasks } from "./ledger-store.js";
import { capUnknown, type RemoteReview } from "./remote-review-parse.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { handoffOf } from "./scheduler-merge-handoff.js";

export const REMOTE_REVIEW_OP = "remote_review";
export const NOTIFIED_OP = "remote_review_notified";
/** A review that did not match the card's head when it arrived, applied once the card reached that head. */
export const APPLIED_OP = "remote_review_applied";

/** Projects whose scheduler.json names this peer as the repository owner. */
export const handoffProjects = (cfg: SchedulerConfig, peer: string): string[] =>
  Object.entries(cfg.projects).filter(([, p]) => p.handoffPeer === peer).map(([id]) => id);

/** The one card of these projects whose PR has this number; none or several = null (the push then goes to PM as before). */
export function matchRemoteCard(db: Database, projects: readonly string[], number: number): LedgerTask | null {
  const hits = projects.flatMap((p) => listTasks(db, p)).filter((t) => prCoordinates(t.pr)?.pr === number);
  return hits.length === 1 ? hits[0]! : null;
}

/** The full head the review is about, if head12 starts it: the card's head, or in merge the PR head the handoff follows now. */
export function remoteHeadMatch(db: Database, task: LedgerTask, head12: string): string | null {
  const heads = [task.headSHA, task.stage === "merge" ? handoffOf(db, task)?.head : null];
  return heads.find((h): h is string => typeof h === "string" && h.toLowerCase().startsWith(head12)) ?? null;
}

const isRemote = (e: LedgerEvent): boolean => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === REMOTE_REVIEW_OP;

const atHead = (e: LedgerEvent, head: string): boolean => typeof e.data.head12 === "string" && head.toLowerCase().startsWith(e.data.head12);
const outranks = (a: LedgerEvent, b: LedgerEvent): boolean => Number(a.data.round) > Number(b.data.round) || (Number(a.data.round) === Number(b.data.round) && a.seq > b.seq);

/**
 * The owner's current word on this head (prefix match), whatever head the card had when it arrived: the booking with the highest
 * round, the later one on a tie. Everything else booked for that head is superseded and never acts.
 */
export function remoteCurrentAt(events: readonly LedgerEvent[], head: string | null): LedgerEvent | null {
  if (!head) return null;
  return events.filter((e) => isRemote(e) && atHead(e, head)).reduce<LedgerEvent | null>((best, e) => (!best || outranks(e, best) ? e : best), null);
}

/** The current word on this head when it is a P1 to fix; an old-format redelivered P1 (capUnknown) is left to PM, so it is not returned. */
export function remoteP1At(events: readonly LedgerEvent[], head: string | null): LedgerEvent | null {
  const e = remoteCurrentAt(events, head);
  return e && Number(e.data.p1) > 0 && !capUnknown(e.data) ? e : null;
}

export const remoteReviewKey = (taskId: string, r: Pick<RemoteReview, "reportId" | "head12">): string =>
  `scheduler:${REMOTE_REVIEW_OP}:${taskId}:${r.reportId}:${r.head12}`;
export const notifiedKey = (seq: number): string => `scheduler:${NOTIFIED_OP}:${seq}`;
export const appliedKey = (seq: number): string => `scheduler:${APPLIED_OP}:${seq}`;

/** Every remote_review* event of this project, by a range on the dedupKey index (all three ops share the prefix): no table scan. */
function remoteRows(db: Database, project: string): { seq: number; target: string; data: string }[] {
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
    const d = JSON.parse(x.data) as { op?: string; matched?: boolean; head12?: unknown };
    if (d.op !== REMOTE_REVIEW_OP || d.matched !== false || typeof d.head12 !== "string" || getEventByDedup(db, appliedKey(x.seq))) return false;
    const task = getTask(db, x.target);
    return !!task && !TERMINAL_STAGES.includes(task.stage) && !!remoteHeadMatch(db, task, d.head12);
  }).map((x) => ({ taskId: x.target, seq: x.seq }));
}
