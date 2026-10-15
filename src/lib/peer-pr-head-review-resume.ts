/**
 * merge-arch-PEERHEAD1 · peerPrHeadResume, a RECBASE1 mechanism (manual-recovery-release.ts): a manual peer PR card (entry code
 * review_unresolved) whose author pushed after a passing review and whose new head this flow registered into review (headWrite,
 * peer-pr-ledger.ts) goes back to auto, so the scheduler dispatches the incremental review (review-converge-order.ts) and the auto
 * path takes it from there: pass → the automatic merge (head-bound, CI), changes → fix. It only judges; the hand-back is the leased
 * `scheduler-manual-resume --mechanism` (fingerprint, re-proof in the transaction, resumeCore). Sticky codes, holds, pause, freeze,
 * open asks and live manual requests are refused by the registry's own base, never here.
 * entryHead: the registration moved the card's head, so the manual entry (recorded on the old head) is matched against the
 * registration's oldHead — only when the registration is this flow's author_push after the entry, oldHead = entry head, newHead =
 * card head, and nothing moved the head since. Key peerPrRequeue (permission class, default observe). tests/peer-pr-head-review*.test.ts.
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { ManualRecoveryMechanism } from "./manual-recovery-release.js";
import type { ManualReasonRecord } from "./manual-reason.js";
import { HEAD_REVIEW_OP, REQUEUE_KEY, reviewSpecRev } from "./peer-pr-head-review.js";

export const PEER_PR_HEAD_RESUME = "peer-pr-head-resume";
const SHA = /^[0-9a-f]{40}$/;

type Reg = { seq: number; oldHead: string; newHead: string; priorReviewSeq: number; round: number; specRev: number };

/** This flow's registration of the card's current round + head on the manual card, complete (author_push, both heads, the prior verdict). */
function registration(task: LedgerTask, events: readonly LedgerEvent[]): Reg | null {
  const e = events.findLast((x) => x.kind === "note" && x.data.op === HEAD_REVIEW_OP);
  const d = e?.data ?? {};
  if (!e || d.cause !== "author_push" || d.flow !== "manual" || d.round !== task.round || d.newHead !== task.headSHA || d.specRev !== task.specRev) return null;
  if (typeof d.oldHead !== "string" || !SHA.test(d.oldHead) || typeof d.newHead !== "string" || typeof d.priorReviewSeq !== "number") return null;
  return { seq: e.seq, oldHead: d.oldHead, newHead: d.newHead, priorReviewSeq: d.priorReviewSeq, round: d.round as number, specRev: d.specRev as number };
}

/** A head change after the registration: a later delivery, or any task write naming headSHA. */
const headMovedSince = (events: readonly LedgerEvent[], seq: number): LedgerEvent | undefined =>
  events.find((e) => e.seq > seq && (e.kind === "deliver" || (e.kind === "task" && JSON.stringify(e.data).includes("headSHA"))));

/** manualBase's head check: the entry head this mechanism vouches for, or null (the card's head, so a moved head is refused as before). */
export function entryHead(task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number, rec: ManualReasonRecord): string | null {
  const r = registration(task, events);
  if (!r || r.seq < entrySeq || r.oldHead !== rec.head || r.newHead !== task.headSHA || headMovedSince(events, r.seq)) return null;
  return rec.head ?? null;
}

const FINDING_BLOCKS = (v: unknown): boolean => Array.isArray(v) && v.some((f) => !!f && typeof f === "object" && ["P0", "P1"].includes(String((f as { severity?: unknown }).severity)));

function judge(task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number): ReturnType<ManualRecoveryMechanism["judge"]> {
  const no = (why: string) => ({ ok: false as const, why: `${why}；留人工（PM 处理）` });
  const meta = task.extra?.peerPr;
  if (task.assigneeKind !== "peer_agent" || !meta || typeof meta !== "object") return no("不是 peer PR 卡");
  if (task.stage !== "review") return no(`卡在 ${task.stage}，不在 review`);
  const r = registration(task, events);
  if (!r) return no("当前轮和当前 head 不是本流程登记的作者新推（author_push）");
  if (r.seq < entrySeq) return no("登记早于这次进 manual");
  const moved = headMovedSince(events, r.seq);
  if (moved) return no(`登记之后 head 又变过（#${moved.seq}）`);
  // the latest structured verdict before the registration, of this spec, is the pass the registration names
  const prior = events.findLast((e) => e.seq < r.seq && e.kind === "review");
  if (!prior || prior.seq !== r.priorReviewSeq || !Array.isArray(prior.data.findings)) return no("登记前最近一条结论不是登记里那条结构化结论");
  if (prior.data.verdict !== "pass" || FINDING_BLOCKS(prior.data.findings)) return no(`登记前最近一条结论是 ${String(prior.data.verdict)}，不是 pass`);
  if (reviewSpecRev(events, prior.seq) !== task.specRev) return no("登记前的结论不是当前规格下的");
  const verdict = events.find((e) => e.seq > r.seq && e.kind === "review" && e.data.round === task.round);
  if (verdict) return no(`本轮已有结论 #${verdict.seq}，不再交回`);
  return { ok: true, episodeId: `r${task.round}.${task.headSHA!.slice(0, 12)}`, subreason: "author_push", cancelIntentId: null, evidenceSeq: r.seq, next: "review" };
}

/** Registered by manual-recovery-release.ts. review_unresolved is shared with other causes; the judge takes only this flow's registrations. */
export const peerPrHeadResume: ManualRecoveryMechanism = {
  id: PEER_PR_HEAD_RESUME, key: REQUEUE_KEY, codes: ["review_unresolved"],
  entryHead,
  judge: (x) => judge(x.task, x.events, x.entrySeq),
};
