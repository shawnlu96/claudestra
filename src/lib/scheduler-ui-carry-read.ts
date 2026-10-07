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
import { currentReviewFacts } from "./scheduler-review.js";

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

/** True only when the current review was written for PM's head and scheduler carries, each with its ui_carry, lead to the card's head. */
export function uiCarriedFrom(db: Database, task: LedgerTask, events: readonly LedgerEvent[], pm: PmUiGate): boolean {
  const review = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (review.kind !== "facts" || !pm.head || review.facts.head !== pm.head || pm.seq === undefined) return false;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  let at = pm.head;
  for (const c of events.filter((e) => e.seq > review.facts.eventSeq && own(e, "review_carry"))) {
    if (c.data.from !== at || !paired(c, bySeq, task, pm.seq)) return false;
    at = String(c.data.to);
  }
  return at === task.headSHA;
}
