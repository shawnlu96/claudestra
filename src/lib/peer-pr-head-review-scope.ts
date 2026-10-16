/**
 * merge-arch-PEERHEAD1 · pure side of the author-push registration: its shape, its op, and the review order's scope line built from it.
 * Kept free of the ledger writer so review-converge-order.ts (loaded by channel-server through order-tools.ts) does not pull
 * ledger-write.ts into processes that never arm the spec preflight (tests/spec-material-preflight-entries.test.ts).
 */
import type { LedgerEvent } from "./ledger-stages.js";

export const HEAD_REVIEW_OP = "peer_pr_head_review";

export interface Registration {
  cause: "author_push"; oldHead: string; newHead: string; priorReviewSeq: number | null; round: number; specRev: number;
  scope: "incremental" | "full"; why: string | null;
  /** The card's workflow when registered: only a manual registration makes a round this flow's own on a manual card. */
  flow: "auto" | "manual";
}

/** The registration that put `head` into `round`, if this flow put it there. */
function registrationOf(events: readonly LedgerEvent[], round: number, head: string | null, flow?: Registration["flow"]): (Registration & { seq: number }) | null {
  const e = events.findLast((x) => x.kind === "note" && x.data.op === HEAD_REVIEW_OP && x.data.round === round && x.data.newHead === head &&
    (flow === undefined || x.data.flow === flow));
  return e ? { ...(e.data as unknown as Registration), seq: e.seq } : null;
}

/** Item 3: the scope line of a review order for a round this flow registered; null for any other round (the order is as before). */
export function headReviewLines(round: number, events: readonly LedgerEvent[], head: string): string[] | null {
  const r = registrationOf(events, round, head);
  if (!r) return null;
  const prior = r.priorReviewSeq === null ? "上轮审查" : `上轮审查 #${r.priorReviewSeq}`;
  if (r.scope === "incremental") {
    return [`第 ${round} 轮是作者在审查后又推了提交：只审作者新改动 git diff ${r.oldHead.slice(0, 12)}..${r.newHead.slice(0, 12)}（旧 head → 新 head）` +
      `+ ${prior} 的 P1 / P2 定向复验；不重审 PR 其余部分，也不按合 main 重审。`];
  }
  return [`第 ${round} 轮是作者推了新提交，但不能只审增量（${r.why}）：全量复审 head ${r.newHead.slice(0, 12)} 相对 main 的改动，并复验 ${prior} 的 P1 / P2。`];
}
