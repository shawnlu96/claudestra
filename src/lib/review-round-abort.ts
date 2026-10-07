/**
 * A review round that was dispatched but never produced a verdict (reviewer overload, PM moved the stage, fallback took the
 * card off auto) is "aborted", not "missing": the P1 streak skips it instead of returning null forever (scheduler-review.ts).
 * A round with no dispatch at all stays missing — nothing proves a review was ever asked for. tests/review-round-abort.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";

/** The planner's intent ids carry the task round: `t68:s<seq>:r<round>:<node>:a<n>` (scheduler-plan.ts makeIntent). */
const intentRound = (id: unknown): number | null => {
  const m = typeof id === "string" ? /:r(\d+):/.exec(id) : null;
  return m ? Number(m[1]) : null;
};

/** Rounds a review was dispatched for: scheduler plans (local or pool), PM's manual dispatch, a fallback's termination record. */
function dispatchedReviewRounds(events: readonly LedgerEvent[]): Set<number> {
  const rounds = new Set<number>();
  for (const e of events) {
    const r = e.kind === "scheduler" && e.data.op === "plan" && e.data.action === "review" ? intentRound(e.data.id)
      : e.kind === "dispatch" && typeof e.data.round === "number" ? e.data.round
      : e.kind === "scheduler" && e.data.op === "fallback_manual" ? abortedRoundOf(e.data.abortedReview)
      : null;
    if (r !== null) rounds.add(r);
  }
  return rounds;
}

const abortedRoundOf = (v: unknown): number | null =>
  v && typeof v === "object" && Number.isInteger((v as { round?: unknown }).round) ? (v as { round: number }).round : null;

function unreviewedDispatches(events: readonly LedgerEvent[]): number[] {
  const reviewed = new Set(events.filter((e) => e.kind === "review" && typeof e.data.round === "number").map((e) => e.data.round as number));
  return [...dispatchedReviewRounds(events)].filter((r) => !reviewed.has(r));
}

/** Rounds below `currentRound` that were dispatched for review but have no review event; the current round is never aborted. */
export const abortedReviewRounds = (events: readonly LedgerEvent[], currentRound: number): Set<number> =>
  new Set(unreviewedDispatches(events).filter((r) => r < currentRound));

/** The termination record a fallback writes: the latest dispatched review round, when it has no verdict yet. */
export function openReviewRound(events: readonly LedgerEvent[]): { round: number } | null {
  const latest = Math.max(0, ...dispatchedReviewRounds(events));
  return unreviewedDispatches(events).includes(latest) ? { round: latest } : null;
}
