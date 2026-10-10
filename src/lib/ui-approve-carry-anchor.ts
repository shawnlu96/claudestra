/**
 * UICARRY2: where a merge-stage `ui-approve` anchors when the card's head moved by review carries after PM's last approval. The
 * carry chain itself is currentReviewFacts' (it alone proves every hop: scheduler review_carry with its merge_phase, formal PM
 * review_main_carry by an accepted actor, same round / specRev / source review, no delivery); here it is only listed in its order.
 * PM's approval may sit on the review's own head (the original rule) or on a later head of that chain, re-given there by an earlier
 * merge-stage ui-approve. Such an intermediate approval counts only when it is the newest verdict, sat on its head between the hop
 * that reached it and the next one, and its own carriedFrom / anchorSeq / prefix / suffix seqs re-prove, recursively, down to an
 * approval on the review head. The whole chain stays within MAX_CARRY_HOPS events; an approval never resets it.
 * Nothing here compares screenshots: PM re-shoots and looks; the digest is a binding, not an image hash.
 * tests/ui-approve-carry-anchor*.test.ts, tests/ui-approve-carried-head*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { projectPmUiGate, UI_APPROVED, UI_REJECTED } from "./ledger-ui-approve-verdict.js";
import { MAIN_CARRY_OP, MAX_CARRY_HOPS } from "./review-main-carry-manual.js";
import { currentReviewFacts } from "./scheduler-review.js";

/** The audit fields of a merge-stage re-approval: the anchor's head, its approval, the hops before it and the carries after it. */
export interface CarryAnchor {
  carriedFrom: string; reviewCarrySeqs: number[];
  /** Only for an intermediate anchor (not on the review head): kept apart so the prefix stays checkable. */
  anchorSeq?: number; sourceReviewSeq?: number; prefixCarrySeqs?: number[];
}

const isSchedulerCarry = (e: LedgerEvent): boolean => e.kind === "scheduler" && e.data.op === "review_carry" && e.actor === "scheduler";
const sameSeqs = (a: unknown, b: readonly number[]): boolean => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

export function uiApproveCarryAnchor(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): CarryAnchor {
  const no = (why: string): never => { throw new LedgerError("conflict", `${task.id} ${why}`); };
  const mayConfigure = (actor: string) => actorMayConfigure(db, actor, task.project);
  const pm = projectPmUiGate(db, task, events);
  if (pm.state !== "approved" || pm.round !== task.round || pm.specRev !== task.specRev) no("本轮/规格最后一条 PM 截图结论不是 approved");
  if (pm.screenshotsDigest !== task.extra.screenshotsDigest) no("PM 截图验收摘要已变");
  if (!pm.head || pm.head === task.headSHA) no("PM 验收 head 没有发生审查沿用");
  const read = currentReviewFacts(task, events, mayConfigure);
  if (read.kind !== "facts") return no(`当前 head 不在本轮审查沿用链上：${read.kind === "invalid" ? read.reason : "缺审查"}`);
  const reviewSeq = read.facts.eventSeq, reviewHead = read.facts.head;
  // The hops currentReviewFacts just proved (same selection as its carriedHead): with the review on the card's head there are none.
  const chain = events.filter((e) => e.seq > reviewSeq && (isSchedulerCarry(e) || (e.kind === "decision" && e.data.op === MAIN_CARRY_OP)));
  const heads = [reviewHead, ...chain.map((c) => String(c.data.to))];
  if ((reviewHead === task.headSHA && chain.length) || heads.at(-1) !== task.headSHA || chain.some((c, i) => c.data.from !== heads[i])) {
    no("沿用链没有从审查 head 连到当前 head");
  }
  if (new Set(heads).size !== heads.length) no("沿用链有重复 head 或循环");
  if (chain.length > MAX_CARRY_HOPS) no(`沿用链超过 ${MAX_CARRY_HOPS} 跳`);
  const seqs = (from: number, to: number, only?: (e: LedgerEvent) => boolean) => chain.slice(from, to).filter((c) => !only || only(c)).map((c) => c.seq);
  if (pm.head === reviewHead) return { carriedFrom: pm.head!, reviewCarrySeqs: seqs(0, chain.length, isSchedulerCarry) }; // the original rule

  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const verdictBefore = (seq: number) => events.findLast((e) => e.seq < seq && e.kind === "decision" &&
    (e.data.op === UI_APPROVED || e.data.op === UI_REJECTED) && mayConfigure(e.actor));
  /** `a` is an approval on chain head index k (0 = review head) that sat there; null when it is not, recursively. */
  const proven = (a: LedgerEvent | undefined, k: number, depth: number): boolean => {
    if (!a || a.kind !== "decision" || a.data.op !== UI_APPROVED || !mayConfigure(a.actor) || depth > chain.length || a.data.head !== heads[k] ||
      a.data.round !== task.round || a.data.specRev !== task.specRev || a.data.screenshotsDigest !== task.extra.screenshotsDigest) return false;
    if ((k > 0 && a.seq < chain[k - 1]!.seq) || (k < chain.length && a.seq > chain[k]!.seq)) return false; // not while the card sat on heads[k]
    if (k === 0) return true; // initial approval on the review head (review or merge stage, before or after the PASS): the original rule
    const prev = verdictBefore(a.seq), j = heads.indexOf(String(a.data.carriedFrom));
    if (!prev || j < 0 || j >= k || prev.data.head !== heads[j] || !sameSeqs(a.data.reviewCarrySeqs, seqs(j, k, isSchedulerCarry))) return false;
    if (a.data.anchorSeq === undefined) return j === 0 && a.data.prefixCarrySeqs === undefined && proven(prev, 0, depth + 1); // written before UICARRY2
    return a.data.anchorSeq === prev.seq && a.data.sourceReviewSeq === reviewSeq && sameSeqs(a.data.prefixCarrySeqs, seqs(0, j)) &&
      proven(prev, j, depth + 1);
  };
  const k = heads.indexOf(pm.head!);
  if (k <= 0 || !proven(bySeq.get(pm.seq!), k, 0)) no("PM 验收 head 与沿用审查原 head 不同，也不是同一沿用链上可核的中间重新验收");
  return { carriedFrom: pm.head!, anchorSeq: pm.seq!, sourceReviewSeq: reviewSeq, prefixCarrySeqs: seqs(0, k),
    reviewCarrySeqs: seqs(k, chain.length, isSchedulerCarry) };
}
