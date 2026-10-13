/**
 * dispatch-recovery-CVCOUNT1 · the one reader of "where this spec revision's reviews start" and "which real rounds a repeated P1
 * spans". The planner's warning, the fix-swap planner and the swap materials all read the same boundary, so they cannot disagree.
 *
 * Boundary: the latest formal event that put the card's workflow on this spec revision — a `workflow` set recorded for it, or the
 * `workflow_resume` that brought the workflow from another revision onto it. A resume on the same revision (round cap released, an
 * interrupted round handed back) is no boundary: counting it would restart every streak and loosen the swap thresholds.
 * Nothing here writes or invents a `workflow` event; the card's round is never reset.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import { normalizedFamily, p1FindingStreak, type ReviewFinding } from "./scheduler-review.js";

/** `seq`: the boundary event (0 = none recorded); `round`: the first reviewed round after it (1 = none yet). */
export interface SpecReviewStart { seq: number; round: number }

const startsSpec = (e: LedgerEvent, specRev: number): boolean => e.kind === "scheduler" && e.data.specRev === specRev &&
  (e.data.op === "workflow" || (e.data.op === "workflow_resume" && typeof e.data.fromSpecRev === "number" && e.data.fromSpecRev !== specRev));

export function specReviewStart(events: readonly LedgerEvent[], specRev: number): SpecReviewStart {
  const seq = events.findLast((e) => startsSpec(e, specRev))?.seq ?? 0;
  const first = events.find((e) => e.kind === "review" && e.seq > seq && typeof e.data.round === "number")?.data.round as number | undefined;
  return { seq, round: first ?? 1 };
}

/**
 * The real rounds, oldest first, whose valid verdicts carry this P1 without a break up to `currentRound`; null = evidence missing.
 * An interrupted round between them is skipped and the verdict before it stays in the range. Which verdict is valid has one
 * definition (scheduler-review.ts p1FindingStreak): a round belongs exactly when starting the count there adds one to it.
 */
function p1ReviewRounds(events: readonly LedgerEvent[], finding: Pick<ReviewFinding, "findingId" | "family">,
  currentRound: number, minRound = 1): number[] | null {
  const rounds: number[] = [];
  for (let from = currentRound; from >= minRound; from--) {
    const streak = p1FindingStreak(events, finding, currentRound, from);
    if (streak === null) return null;
    if (streak > rounds.length) rounds.unshift(from);
  }
  return rounds;
}

/**
 * Whether this spec revision already ran `mode` for one of these findings inside its own unbroken range. The range is read from
 * real rounds, never as `current - streak + 1`: with interrupted rounds in between that arithmetic drops the swap already done.
 * A finding that was resolved and came back, or one counted under another spec revision, starts a range the old swap is outside of.
 */
export function strategyPerformed(events: readonly LedgerEvent[], specRev: number, mode: string,
  findings: readonly Pick<ReviewFinding, "findingId" | "family">[], currentRound: number, minRound = 1): boolean {
  const ranges = findings.map((finding) => ({ finding, rounds: p1ReviewRounds(events, finding, currentRound, minRound) ?? [] }));
  return events.some((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" && e.data.specRev === specRev && e.data.mode === mode &&
    typeof e.data.round === "number" && Array.isArray(e.data.findings) && ranges.some(({ finding, rounds }) =>
    rounds.length > 0 && (e.data.round as number) >= rounds[0] && (e.data.round as number) <= currentRound &&
    (e.data.findings as { findingId?: string; family?: string }[]).some((f) => f.findingId === finding.findingId ||
      typeof f.family === "string" && normalizedFamily(f.family) === normalizedFamily(finding.family))));
}
