/**
 * A review round that was dispatched but never produced a verdict (reviewer overload, PM moved the stage, fallback took the
 * card off auto) is "aborted", not "missing": the P1 streak skips it instead of returning null forever (scheduler-review.ts).
 * A round with no delivered dispatch stays missing — nothing proves a review was ever asked for. tests/review-round-abort.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";

/** planIntent stamps the card's round on the plan event (any id, CLI included); plans written before that only have the
 *  planner's id format `t68:s<seq>:r<round>:<node>:a<n>` (scheduler-plan.ts makeIntent). */
const planRound = (data: Record<string, unknown>): number | null => {
  if (Number.isInteger(data.round)) return data.round as number;
  const m = typeof data.id === "string" ? /:r(\d+):/.exec(data.id) : null;
  return m ? Number(m[1]) : null;
};

/** Intents proven delivered: settled done (receipt sent / reconciled), or taken by the recipient. `submitted` is only the claim
 *  written before worker.submit (scheduler-dispatch.ts) and is followed by cancelled when the recipient rejects, so it proves nothing. */
const deliveredIntents = (events: readonly LedgerEvent[]): Set<unknown> => new Set(events.filter((e) => e.kind === "scheduler" &&
  (e.data.op === "settle" && e.data.to === "done" || e.data.op === "order_taken")).map((e) => e.data.id));

/** Rounds a review was delivered for: delivered scheduler plans (local or pool), PM's manual dispatch, a fallback's termination record. */
function dispatchedReviewRounds(events: readonly LedgerEvent[]): Set<number> {
  const rounds = new Set<number>();
  const delivered = deliveredIntents(events);
  for (const e of events) {
    const r = e.kind === "scheduler" && e.data.op === "plan" && e.data.action === "review" && delivered.has(e.data.id) ? planRound(e.data)
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
