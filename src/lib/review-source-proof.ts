/**
 * UIRES2 · where a review verdict came from, read once for both its readers: the planner's review gates (scheduler-plan.ts
 * reviewStep / mergeReviewGate) and UI manual recovery (manual-recovery-ui.ts reviewGate). Pure, read-only, snapshot facts only;
 * it imports neither the planner, the snapshot reader nor manual recovery (the latter two would close a cycle through the planner).
 * reviewStep asks the two halves separately to keep review_unsolicited / reviewer_mismatch and its transition wait between them;
 * the others take the whole predicate. tests/review-source-proof.test.ts.
 */
import type { AuthorFamily, SchedulerIntent, TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { poolExemptFacts } from "./ledger-pool-refusal-gate.js";
import { centerReviewed } from "./scheduler-center-facts.js";
import { adoptedReview } from "./scheduler-manual-review-source.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { exemptFacts, latestReviewerSwap } from "./scheduler-review-swap.js";
import { securityReviewLocalOnly, type SecurityPoolMode } from "./security-pool.js";

/** The snapshot fields the source proof reads (a PlannerSnapshot satisfies it). */
export type ReviewSourceSnapshot = Parameters<typeof adoptedReview>[0] & {
  task: LedgerTask;
  workflow: TaskWorkflow | null;
  events: readonly LedgerEvent[];
  intents: readonly SchedulerIntent[];
  reviewer: { agent: string; sessionId: string; family: AuthorFamily; source: "local" | "peer_claim" } | null;
  reviewDispatches: readonly { intentId: string; round: number; head: string; reviewer: string; reviewerSessionId: string; ackSeq: number }[];
  securityPool?: SecurityPoolMode;
};

/**
 * The dispatch receipt: this round's review order, placed after the stage entry and the last reviewer swap (after a swap, on the
 * current specRev), before the verdict, same head and recipient, submitted / done; acknowledged by the verdict's own session
 * between the order and the verdict.
 */
export function reviewDispatchProof(s: ReviewSourceSnapshot, facts: ReviewFacts): boolean {
  const swap = latestReviewerSwap(s.events);
  const entered = s.events.findLast((e) => e.kind === "stage" && e.data.to === "review" && e.data.round === facts.round)?.seq ?? 0;
  const dispatched = s.intents.findLast((i) => i.node === "adversarial_review" && i.action === "review" &&
    i.eventSeq > entered && i.eventSeq < facts.eventSeq &&
    i.eventSeq > (swap?.seq ?? 0) && (!swap || i.specRev === s.task.specRev) &&
    i.head === facts.head && i.recipient === facts.reviewer && (i.status === "submitted" || i.status === "done"));
  return !!dispatched && s.reviewDispatches.some((p) => p.intentId === dispatched.id && p.round === facts.round &&
    p.head === facts.head && p.reviewer === facts.reviewer && p.reviewerSessionId === facts.reviewerSessionId &&
    p.ackSeq > dispatched.eventSeq && p.ackSeq < facts.eventSeq);
}

/** The verdict is the card's reviewer session: cross-model (or formally exempt), and local when the security template says so. */
export function reviewerSessionMatches(s: ReviewSourceSnapshot, facts: ReviewFacts): boolean {
  return !!s.reviewer && facts.reviewer === s.reviewer.agent && facts.reviewerSessionId === s.reviewer.sessionId &&
    facts.reviewerFamily === s.reviewer.family && (facts.reviewerFamily !== s.workflow?.authorFamily || exemptFacts(s.events, s.task, facts) || poolExemptFacts(s.events, s.task, facts)) &&
    !(securityReviewLocalOnly(s.workflow, s.securityPool) && s.reviewer.source !== "local");
}

/** The whole source: PM-adopted manual verdict (AUTOACK1) or central review (S2F9), else dispatch receipt plus reviewer session. */
export function reviewSourced(s: ReviewSourceSnapshot, facts: ReviewFacts): boolean {
  return adoptedReview(s, facts) || centerReviewed(s, facts) || (reviewDispatchProof(s, facts) && reviewerSessionMatches(s, facts));
}
