/**
 * merge-arch-REVIEW1 · reader: a review still covers the task head when a scheduler `merge_content_review` event (written by
 * merge-content-review.ts after judgeContentEvidence and a ledger re-check) names that review by explicit seq — never by sitting
 * next to a review_carry / merge_phase / UI event — and still binds this round, spec revision, report, reviewer and head.
 * Honoured only under mergeContentReview = on; after a switch to observe / off a projection authorizes nothing new: the sender's
 * own `beforeSend` read refuses (unsentAware), and only the run whose `merging` claim is the card's latest phase keeps reading it
 * (verified, never re-sent). observe / off otherwise: currentReviewFacts
 * answers exactly as before. Every read re-checks the source report on disk and that the source review was written under this spec
 * revision, so a report removed or a spec changed after (or before) the projection is never carried. No ledger import:
 * scheduler-review.ts loads this, and the policy read is injected by merge-content-review.ts (absent = not on, so a process that
 * never loaded the writer fails closed). tests/merge-content-review*.test.ts.
 */
import { existsSync } from "node:fs";
import type { LedgerEvent } from "./ledger-stages.js";
import type { RecoveryMode } from "./recovery-policy.js";

export const MERGE_CONTENT_REVIEW_OP = "merge_content_review";
export const MERGE_ARCH_OBSERVE_OP = "merge_arch_observe";
const SHA = /^[a-f0-9]{40}$/;

let modePort: ((project: string) => RecoveryMode) | null = null;
/** merge-content-review.ts sets the file-backed read at load; tests swap it. */
export function setContentModePort(port: ((project: string) => RecoveryMode) | null): void { modePort = port; }
/** No port or a throwing read is "off": a switch that cannot be read never authorizes. */
export function contentModeNow(project: string): RecoveryMode {
  try { return modePort?.(project) ?? "off"; } catch { return "off"; }
}

/** One projection per (card, source review, carried head). */
export const contentReviewKey = (taskId: string, reviewSeq: number, head: string): string => `merge-content-review:${taskId}:${reviewSeq}:${head}`;

type CarryTask = { round: number; headSHA: string | null; specRev: number };

/** The spec revision an event records: `data.specRev` (moves, workflow, scheduler) or a task row patch's `specRev`. */
function specRecorded(e: LedgerEvent): number | undefined {
  const patch = e.kind === "task" ? (e.data.patch as { specRev?: unknown } | undefined) : undefined;
  const v = typeof e.data.specRev === "number" ? e.data.specRev : patch?.specRev;
  return typeof v === "number" ? v : undefined;
}
/**
 * Was `review` written under `specRev` and has it stayed there? The latest revision recorded before the review must be it and no
 * later event may record another; a task row whose specRev no longer matches (even with no event) fails the caller's own compare.
 */
export function reviewUnderSpec(events: readonly LedgerEvent[], review: LedgerEvent, specRev: number): boolean {
  const before = events.findLast((e) => e.seq < review.seq && specRecorded(e) !== undefined);
  return !!before && specRecorded(before) === specRev && events.every((e) => e.seq < review.seq || (specRecorded(e) ?? specRev) === specRev);
}
/** The source report is still on disk; an unreadable path is missing. */
const reportLive = (path: unknown): boolean => {
  try { return typeof path === "string" && path !== "" && existsSync(path); } catch { return false; }
};

/** Scheduler-written projections of this source review, in seq order. */
export function projectionsOf(events: readonly LedgerEvent[], reviewSeq: number): LedgerEvent[] {
  return events.filter((e) => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === MERGE_CONTENT_REVIEW_OP && e.data.sourceReviewSeq === reviewSeq);
}

/** The intent whose `merging` claim its own sender is re-reading right before the merge API (`beforeSend`): known unsent. */
let unsentIntent: string | null = null;
/**
 * Wraps the merge driver's recheck (scheduler-service.ts): a `beforeSend` read runs with its intent marked unsent, so a projection
 * after a switch to observe / off refuses it (nothing sent yet), while every other read of a `merging` row may still verify it.
 */
export function unsentAware<R extends { intentId: string; beforeSend?: true }, T>(read: (run: R) => T): (run: R) => T {
  return (run) => {
    if (!run.beforeSend) return read(run);
    const prev = unsentIntent;
    unsentIntent = run.intentId;
    try { return read(run); } finally { unsentIntent = prev; }
  };
}

/**
 * The run that already sent its merge after this projection: the card's latest merge_phase after it is that run's own `merging`
 * claim (or its `merged` receipt after that claim), and no sender is reading it as unsent. Verified, never a new authorization; an
 * older or other run's claim, or one that since went unknown / resolved, restores nothing.
 */
function sentAfter(events: readonly LedgerEvent[], seq: number): boolean {
  const phases = events.filter((e) => e.seq > seq && e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === "merge_phase");
  const last = phases.at(-1), intent = last?.data.intentId;
  if (!last || typeof intent !== "string" || intent === unsentIntent || !["merging", "merged"].includes(String(last.data.to))) return false;
  return phases.some((e) => e.data.intentId === intent && e.data.to === "merging" && e.seq <= last.seq);
}

/** Does a stored projection carry `review` (given at `head`) to task.headSHA now? Pure apart from the injected mode read. */
export function contentReviewCarries(task: CarryTask, events: readonly LedgerEvent[], review: LedgerEvent, head: string): boolean {
  const now = task.headSHA;
  if (!now || !SHA.test(now) || events.some((e) => e.seq > review.seq && e.kind === "deliver")) return false;
  const all = projectionsOf(events, review.seq).filter((e) => e.seq > review.seq);
  const hit = all.findLast((e) => e.data.to === now);
  if (!hit || (contentModeNow(review.project) !== "on" && !sentAfter(events, hit.seq))) return false;
  const d = hit.data, ev = (d.evidence ?? {}) as Record<string, unknown>, r = review.data;
  if (all.some((e) => e.data.diffHash !== d.diffHash)) return false; // the net diff changed between hops: no hop carries
  if (hit.dedupKey !== contentReviewKey(hit.target, review.seq, now) || d.from !== head || d.round !== task.round || d.specRev !== task.specRev) return false;
  if (d.sourceSpecRev !== task.specRev || !reviewUnderSpec(events, review, task.specRev) || !reportLive(r.path)) return false;
  if (d.reportPath !== r.path || d.reviewer !== r.reviewer || d.reviewerSessionId !== r.reviewerSessionId || d.reviewerFamily !== r.reviewerFamily) return false;
  const scope = (ev.scope ?? {}) as Record<string, unknown>;
  return ev.diffHash === d.diffHash && ev.approvedHead === head && ev.currentHead === now && ev.sourceReviewSeq === review.seq &&
    scope.taskId === hit.target && scope.round === task.round && scope.specRev === task.specRev;
}
