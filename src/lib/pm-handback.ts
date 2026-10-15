/**
 * PMHAND1 · the automatic paths a card picks up again after a PM took it over by hand. Pure judgements only (no writes); the
 * sample notes they lead to are written by pm-handback-sample.ts, the resolved-deploy verify by pm-handback-verify.ts.
 * - 9补: a retired author binding binds nobody, for the order list (order-take.ts) and the claim (memory-retrieve-take.ts) alike.
 * - 11a: a review verdict older than the card's latest PM hand-back (workflow_resume marked manual) is not this round's.
 * - 11b: a hold is lifted for the manual merge queue by a later manual-merge-request of the person who set it.
 * Doc: docs/architecture/pm-handback.md. Tests: tests/pm-handback.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import type { PlannerDecision } from "./scheduler-plan.js";
import type { SchedulerSession } from "./scheduler-sessions.js";

/** The binding that still binds: a retired one is the same as none (both callers ask this, never `state` themselves). */
export const liveBinding = (b: SchedulerSession | null | undefined): SchedulerSession | null => b && b.state !== "retired" ? b : null;

/** The seq of the card's latest PM hand-back (`ledger workflow-resume` by PM / master / owner, not the scheduler's own). */
const lastPmHandback = (events: readonly LedgerEvent[]): number | null =>
  events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow_resume" && e.data.manual === true)?.seq ?? null;

/** Strictly earlier than the latest PM hand-back: a verdict written after it (or with no hand-back at all) is judged as before. */
export function reviewBeforeHandback(events: readonly LedgerEvent[], reviewSeq: number): boolean {
  const at = lastPmHandback(events);
  return at !== null && reviewSeq < at;
}

/** Marks the review dispatch planned in place of review_unsolicited (the intent's reason; the sample sweep finds it by it). */
export const HANDBACK_REVIEW_TAG = "[PMHAND1 交回前结论不算本轮]";
export function handbackReviewDispatch(d: PlannerDecision): PlannerDecision {
  return d.kind === "intent" ? { ...d, reason: `${HANDBACK_REVIEW_TAG} ${d.reason}` } : d;
}

/** The card's latest workflow event when it holds the card in manual (PM / owner hold, ledger-scheduler-write.ts). */
export const holdOf = (events: readonly LedgerEvent[]): LedgerEvent | null => {
  const t = events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow");
  return t?.data.hold ? t : null;
};

/** The request is newer than the hold and filed by whoever set it (an owner hold: only the owner's own request). */
export const holdLiftedBy = (hold: Pick<LedgerEvent, "seq" | "actor">, req: { seq: number; requestedBy: string }): boolean =>
  req.seq > hold.seq && req.requestedBy === hold.actor;

/** The hold that still stands for the manual merge queue, judged for `req` (none: every hold stands). */
export function standingHold(events: readonly LedgerEvent[], req?: { seq: number; requestedBy: string } | null): LedgerEvent | null {
  const hold = holdOf(events);
  return hold && !(req && holdLiftedBy(hold, req)) ? hold : null;
}
