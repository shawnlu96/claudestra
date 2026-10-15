/**
 * PMHAND1 · the automatic paths a card picks up again after a PM took it over by hand. Pure judgements only (no writes); the
 * sample notes they lead to are written by pm-handback-sample.ts, the resolved-deploy verify by pm-handback-verify.ts.
 * - 9补: a retired author binding binds nobody, for the order list (order-take.ts) and the claim (memory-retrieve-take.ts) alike.
 * - 11a: a review verdict older than the card's latest PM hand-back (workflow_resume marked manual) is not this round's.
 * - 11b: a hold is lifted for the manual merge queue by a later manual-merge-request of the person who set it.
 * Doc: docs/architecture/pm-handback.md. Tests: tests/pm-handback.test.ts.
 */
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { currentReviewFacts, type ReviewFacts, type ReviewRead } from "./scheduler-review.js";
import type { SchedulerSession } from "./scheduler-sessions.js";

/** The binding that still binds: a retired one is the same as none (both callers ask this, never `state` themselves). */
export const liveBinding = (b: SchedulerSession | null | undefined): SchedulerSession | null => b && b.state !== "retired" ? b : null;

/** The card's latest PM hand-back (`ledger workflow-resume` by PM / master / owner, not the scheduler's own). */
const lastPmHandbackEvent = (events: readonly LedgerEvent[]): LedgerEvent | null =>
  events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow_resume" && e.data.manual === true) ?? null;
const lastPmHandback = (events: readonly LedgerEvent[]): number | null => lastPmHandbackEvent(events)?.seq ?? null;

/** Strictly earlier than the latest PM hand-back: a verdict written after it (or with no hand-back at all) is judged as before. */
export function reviewBeforeHandback(events: readonly LedgerEvent[], reviewSeq: number): boolean {
  const at = lastPmHandback(events);
  return at !== null && reviewSeq < at;
}

/**
 * The verdict the planner reads (`found`, reviewStep's epoch read) when it is older than the latest PM hand-back and nothing else
 * makes it this round's: a structured one that `counts` does not accept (AUTOACK1 adopted / S2F9 central / the scheduler's own
 * dispatch), or one that does not read at all (a legacy hand-written `ledger review`, or a malformed one: invalid, judged by the
 * round's latest review event). Checked before the invalid / unsolicited escalations, so either kind written before the hand-back
 * is dispatched past. null = judged as before.
 */
function staleBeforeHandback(s: Pick<PlannerSnapshot, "task" | "events">, found: ReviewRead, counts: (f: ReviewFacts) => boolean): number | null {
  if (found.kind === "none") return null;
  if (found.kind === "facts") return reviewBeforeHandback(s.events, found.facts.eventSeq) && !counts(found.facts) ? found.facts.eventSeq : null;
  const latest = s.events.findLast((e) => e.kind === "review" && e.data.round === s.task.round);
  return latest && reviewBeforeHandback(s.events, latest.seq) ? latest.seq : null;
}

/** 11a in reviewStep: the review dispatch on the current head in place of a stale verdict (tagged), or null to go on as before. */
export function handbackReview(s: PlannerSnapshot, node: string, found: ReviewRead, counts: (f: ReviewFacts) => boolean,
  dispatch: (s: PlannerSnapshot) => PlannerDecision): PlannerDecision | null {
  const stale = staleBeforeHandback(s, found, counts);
  return stale === null ? null : handbackReviewDispatch(dispatch(handbackSnapshot(s, node, staleRound(s, counts))));
}

/**
 * Every review event of this round older than the latest PM hand-back that does not count (each read as the latest one would be,
 * with the events up to it): structured or legacy, any of them would otherwise read as the card's prior reviewer (reviewer_replaced).
 * One that counts (AUTOACK1 / S2F9 / the scheduler's own dispatch) is kept, so its continuity and independence rules stand.
 */
function staleRound(s: Pick<PlannerSnapshot, "task" | "events">, counts: (f: ReviewFacts) => boolean): Set<number> {
  const at = lastPmHandback(s.events)!;
  return new Set(s.events.filter((e) => e.kind === "review" && e.data.round === s.task.round && e.seq < at).filter((e) => {
    const read = currentReviewFacts(s.task, s.events.filter((x) => x.seq <= e.seq));
    return read.kind !== "facts" || !counts(read.facts);
  }).map((e) => e.seq));
}

/** Marks the review dispatch planned in place of review_unsolicited (the intent's reason; the sample sweep finds it by it). */
export const HANDBACK_REVIEW_TAG = "[PMHAND1 交回前结论不算本轮]";
function handbackReviewDispatch(d: PlannerDecision): PlannerDecision {
  return d.kind === "intent" ? { ...d, reason: `${HANDBACK_REVIEW_TAG} ${d.reason}` } : d;
}

/** Planned before `at`: by its plan event's seq, or (no plan event in view) by its creation time against the hand-back's. */
function plannedBefore(events: readonly LedgerEvent[], i: SchedulerIntent, at: LedgerEvent): boolean {
  const plan = events.find((e) => e.kind === "scheduler" && e.data.op === "plan" && e.data.id === i.id);
  return plan ? plan.seq < at.seq : i.createdAt < at.ts;
}

/**
 * The planner's view for the 11a dispatch: the stale verdicts themselves are left out (every one of the round before the hand-back
 * that does not count, staleRound: none is this round's, so none reads as the card's prior reviewer nor bounds anything), and a review intent of `node` that already finished (`done`) and was planned before the
 * latest PM hand-back belongs to the round the PM took over, so it reads as cancelled and no longer holds the dispatch in `in_flight`.
 * Intents planned after the hand-back, and any still pending / submitted / unknown, are kept as they are (the usual in-flight dedup);
 * the intent list itself is unchanged, so the new intent's attempt key still counts them.
 */
function handbackSnapshot(s: PlannerSnapshot, node: string, staleSeqs: ReadonlySet<number>): PlannerSnapshot {
  const at = lastPmHandbackEvent(s.events)!;
  const stale = (i: SchedulerIntent) => i.node === node && i.action === "review" && i.status === "done" && plannedBefore(s.events, i, at);
  return { ...s, events: s.events.filter((e) => !staleSeqs.has(e.seq)),
    intents: s.intents.some(stale) ? s.intents.map((i) => stale(i) ? { ...i, status: "cancelled" as const } : i) : s.intents };
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
