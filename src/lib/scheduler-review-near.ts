/**
 * i28-CONV7: a P1 whose only marker is near (「[验收线 1、2;PM 定 4]」) counts toward the P1 streak in the rounds where the
 * planner really kept it a P1: CONV6's `review_near_marker` record with mode on and counted true (review-converge-followup.ts).
 * Read from that record, never from the live nearMarker switch, so a past round's answer does not move when the switch does;
 * observe / off never write a counted record and so read exactly as before. tests/scheduler-review-near.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";

/** CONV6's op (review-converge.ts NEAR_OP), spelled here: that module imports scheduler-review.ts and reaches the policy reader. */
export const NEAR_COUNTED_OP = "review_near_marker";

/** The round's record says 「已按 P1 计」 for this finding, on the head that round's review covered. */
export function nearCountedP1(events: readonly LedgerEvent[], round: number, findingId: string): boolean {
  const head = events.findLast((e) => e.kind === "review" && e.data.round === round)?.data.head;
  return typeof head === "string" && events.some((e) => e.kind === "scheduler" && e.data.op === NEAR_COUNTED_OP &&
    e.data.round === round && e.data.head === head && e.data.findingId === findingId && e.data.mode === "on" && e.data.counted === true);
}
