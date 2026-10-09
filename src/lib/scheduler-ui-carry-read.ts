/**
 * UICAR2 read side: PM's screenshot acceptance bound to an older head still counts when every hop from it to the card's head is
 * the scheduler's own update-branch carry (review_carry) with its paired `ui_carry` (scheduler-ui-carry.ts writes it at carrySeq + 2,
 * right after the carry's merge_phase). The review chain itself is currentReviewFacts' business; a PM review_main_carry hop breaks it.
 * A leaf: scheduler-ui-merge-refusal.ts imports it. tests/scheduler-ui-carry*.test.ts.
 */
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { PmUiGate } from "./ledger-ui-approve-verdict.js";
import type { RecoveryPolicyPort } from "./recovery-policy.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { reviewCarryPaired, uiReviewCarryMode } from "./scheduler-ui-review-carry.js";

export const UI_CARRY_OP = "ui_carry";
export const uiCarryKey = (intentId: string, carrySeq: number): string => `scheduler:${intentId}:ui-carry:${carrySeq}`;

const own = (e: LedgerEvent | undefined, op: string): e is LedgerEvent => e?.kind === "scheduler" && e.actor === "scheduler" && e.data.op === op;

/** The ui_carry the scheduler wrote for this carry, bound to the same intent / heads / round / specRev / digest / PM verdict. */
function paired(c: LedgerEvent, bySeq: Map<number, LedgerEvent>, task: LedgerTask, approvalSeq: number): boolean {
  const u = bySeq.get(c.seq + 2), d = u?.data, phase = bySeq.get(c.seq + 1);
  return own(u, UI_CARRY_OP) && own(phase, "merge_phase") && phase.data.carrySeq === c.seq && u.dedupKey === uiCarryKey(String(c.data.intentId), c.seq) &&
    d!.carrySeq === c.seq && d!.intentId === c.data.intentId && d!.from === c.data.from && d!.to === c.data.to && d!.mainParent === c.data.mainParent &&
    d!.round === c.data.round && d!.round === task.round && d!.specRev === c.data.specRev && d!.specRev === task.specRev &&
    d!.digest === task.extra.screenshotsDigest && d!.approvalSeq === approvalSeq && Array.isArray(d!.touched) && d!.touched.length === 0;
}

/**
 * UICAR2 (uiReviewCarry not on): true only when the current review was written for PM's head and scheduler carries, each with its
 * ui_carry, lead to the card's head.
 * UIR1 (uiReviewCarry on, superseding UICAR2's weaker touched-list proof): the code carry chain from the review's head to the card's
 * head must link hop by hop on its own; PM's approval (possibly re-given on a later head of that chain) splits it: the carries before
 * it must end on exactly the head PM approved, and every carry after it must start there and carry its ui_review_carry bound to that
 * very approval (scheduler-ui-review-carry.ts reviewCarryPaired).
 */
export function uiCarriedFrom(db: Database, task: LedgerTask, events: readonly LedgerEvent[], pm: PmUiGate, policy?: RecoveryPolicyPort): boolean {
  const review = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (review.kind !== "facts" || !pm.head || pm.seq === undefined) return false;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const carries = events.filter((e) => e.seq > review.facts.eventSeq && own(e, "review_carry"));
  if (uiReviewCarryMode(task.project, policy) !== "on") {
    if (review.facts.head !== pm.head) return false;
    let at = pm.head;
    for (const c of carries) {
      if (c.data.from !== at || !paired(c, bySeq, task, pm.seq)) return false;
      at = String(c.data.to);
    }
    return at === task.headSHA;
  }
  let at = review.facts.head, approvedAt: string | null = pm.seq > review.facts.eventSeq ? null : at;
  for (const c of carries) {
    if (c.data.from !== at) return false; // the code chain itself breaks
    if (c.seq > pm.seq) {
      approvedAt ??= at; // the head the card sat on when PM approved
      if (approvedAt !== pm.head || !reviewCarryPaired(c, bySeq, task, pm, policy)) return false;
    }
    at = String(c.data.to);
  }
  return (approvedAt ?? at) === pm.head && at === task.headSHA;
}
