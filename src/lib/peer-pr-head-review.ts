/**
 * merge-arch-PEERHEAD1 · a peer PR whose review passed and whose author then pushed again. Read side and the shared bits of the
 * two switches; the transactions are peer-pr-ledger.ts (observeWrite / headWrite), the manual card's hand-back is the RECBASE1
 * mechanism peerPrHeadResume (peer-pr-head-review-resume.ts).
 * - unresolvedP1Rounds: how many rounds in a row, ending at the latest verdict of this spec, still left a P1. Only that run of
 *   rounds spends maxRounds; a pass that was re-reviewed only because of a new head costs nothing. Rounds still only go up.
 * - the registration event (op peer_pr_head_review, cause author_push) names oldHead / newHead / priorReviewSeq and whether the
 *   next review may look at the author's increment only; headReviewLines turns it into the review order's scope line.
 * - flowBlock: hold, card pause, frozen queue, unanswered ask, safety hold stop every registration of this flow (peer cards have no feature).
 * Switches: peerPrHeadReview (items 1–3, new key, default on) and peerPrRequeue (peerPrHeadResume's key: hand a registered manual card
 * back to auto; permission class, default observe, read by the registry through manual-recovery-policy.ts).
 * docs/architecture/peer-pr-head-review.md; tests/peer-pr-head-review*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { cardPauseState } from "./card-pause.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { standingHold } from "./pm-handback.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { downgradedIds, type ReviewFacts } from "./scheduler-review.js";
import { openSafetyHold } from "./scheduler-review-swap.js";

export const HEAD_REVIEW_KEY = "peerPrHeadReview";
export const REQUEUE_KEY = "peerPrRequeue";
export const HEAD_REVIEW_OP = "peer_pr_head_review";

let policyPort: RecoveryPolicyPort = recoveryPolicy;
/** Tests inject a fake policy; null restores the file-backed one. */
export function configureHeadReviewPolicy(port: RecoveryPolicyPort | null): void { policyPort = port ?? recoveryPolicy; }

const modeOf = (project: string, key: typeof HEAD_REVIEW_KEY): RecoveryMode => {
  try {
    return policyPort(project, key).mode;
  } catch (e) {
    console.error(`⚠️ [peer-pr] ${project} 读恢复策略 ${key} 失败，按 off：${(e as Error).message}`);
    return "off";
  }
};
/** Read right before each use; unreadable = off (the path as it was). */
export const headReviewMode = (project: string): RecoveryMode => modeOf(project, HEAD_REVIEW_KEY);

/** One round of this spec: its latest verdict (null = none yet; "unknown" = a review without a structured verdict) and its P1 count. */
export interface RoundVerdict { round: number; verdict: string | null; p1: number }

/**
 * Pure: rounds in a row, from the latest round with a verdict backwards, whose verdict still had a P1 (or blocked, or cannot be
 * read as anything else). A passing round ends the run; a round with no verdict yet neither counts nor ends it.
 */
export function unresolvedP1Rounds(seq: readonly RoundVerdict[]): number {
  let n = 0;
  for (const v of [...seq].sort((a, b) => b.round - a.round)) {
    if (v.verdict === null) continue;
    if (v.p1 > 0 || !["pass", "changes"].includes(v.verdict)) n++;
    else break;
  }
  return n;
}

const findingRows = (v: unknown): { findingId?: unknown; severity?: unknown }[] | null =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : null;

/** The card's rounds under `specRev` (entered review with that spec), each with its latest review; P1s the planner downgraded do not count. */
export function roundVerdicts(events: readonly LedgerEvent[], specRev: number): RoundVerdict[] {
  const rounds = new Set(events.filter((e) => e.kind === "stage" && e.data.to === "review" && e.data.specRev === specRev && typeof e.data.round === "number")
    .map((e) => e.data.round as number));
  return [...rounds].sort((a, b) => a - b).map((round) => {
    const r = events.findLast((e) => e.kind === "review" && e.data.round === round);
    if (!r) return { round, verdict: null, p1: 0 };
    const demoted = downgradedIds(events, round), rows = findingRows(r.data.findings);
    const p1 = rows ? rows.filter((f) => f.severity === "P1" && !demoted.has(String(f.findingId))).length : Number(r.data.p1) || 0;
    return { round, verdict: typeof r.data.verdict === "string" ? r.data.verdict : "unknown", p1 };
  });
}

/** Item 1: the card's maxRounds budget is spent only by consecutive unresolved P1 rounds of its current spec. */
export const p1RoundsSpent = (events: readonly LedgerEvent[], task: Pick<LedgerTask, "specRev">): number =>
  unresolvedP1Rounds(roundVerdicts(events, task.specRev));

/** A verdict the merge gate lets through: no P0 / P1, not block, and pass or changes with only P2 (scheduler-merge.ts mergeRunDrift). */
export const passingFacts = (f: Pick<ReviewFacts, "verdict" | "findings">): boolean =>
  !f.findings.some((x) => x.severity === "P0" || x.severity === "P1") && (f.verdict === "pass" || (f.verdict === "changes" && f.findings.some((x) => x.severity === "P2")));

/** How the new head relates to the reviewed one (peer-pr-head-review-git.ts reads it from the repository). */
export type Lineage = "successor" | "force" | "main_merge" | "missing";

export interface Registration {
  cause: "author_push"; oldHead: string; newHead: string; priorReviewSeq: number | null; round: number; specRev: number;
  scope: "incremental" | "full"; why: string | null;
  /** The card's workflow when registered: only a manual registration makes a round this flow's own on a manual card. */
  flow: "auto" | "manual";
}

/** Only the author's increment may be reviewed when the new head descends from the reviewed one under the same spec. */
export function registrationScope(lineage: Lineage, priorSpecRev: number | null, specRev: number): Pick<Registration, "scope" | "why"> {
  if (priorSpecRev !== null && priorSpecRev !== specRev) return { scope: "full", why: "规格变了" };
  if (lineage === "successor") return { scope: "incremental", why: null };
  const why = lineage === "force" ? "新 head 不是旧 head 的后继（force-push）"
    : lineage === "missing" ? "增量对象缺失，读不到旧 / 新 head 的关系" : "新 head 是合 main，不是作者改动";
  return { scope: "full", why };
}

/** The specRev the round that reviewed `reviewSeq` ran under (the stage event that entered it), null when unknown. */
export function reviewSpecRev(events: readonly LedgerEvent[], reviewSeq: number | null): number | null {
  const review = reviewSeq === null ? undefined : events.find((e) => e.seq === reviewSeq);
  if (!review) return null;
  const entered = events.findLast((e) => e.seq < review.seq && e.kind === "stage" && e.data.to === "review" && e.data.round === review.data.round);
  return typeof entered?.data.specRev === "number" ? entered.data.specRev : null;
}

/** Written inside the caller's transaction, right after deliver put the new head into review. */
export function writeRegistration(db: Database, ctx: WriteCtx, task: Pick<LedgerTask, "project" | "id">, r: Registration, extra: Record<string, unknown> = {}): LedgerEvent {
  const text = r.scope === "incremental"
    ? `作者推了新提交 ${r.newHead.slice(0, 12)}：第 ${r.round} 轮只审增量 ${r.oldHead.slice(0, 12)}..${r.newHead.slice(0, 12)}`
    : `作者推了新提交 ${r.newHead.slice(0, 12)}：第 ${r.round} 轮全量复审（${r.why}）`;
  // a note (peers never see notes); dedup per card + round + head, so a replayed registration is the same event
  return appendEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: `peerpr:head:${task.id}:${r.round}:${r.newHead}` }, { project: task.project, target: task.id,
    kind: "note", text, data: { op: HEAD_REVIEW_OP, ...r, ...extra } }).event;
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

/** Item 7: what stops a registration of this flow (auto and manual); null = nothing does. The hand-back re-checks the same in the registry's base. */
export function flowBlock(db: Database, task: Pick<LedgerTask, "id" | "project">, events: readonly LedgerEvent[]): string | null {
  if (getMeta(db, task.project).queueFrozen.frozen) return "项目合并队列已冻结";
  const hold = standingHold(events);
  if (hold) return `卡被明确留在人工（#${hold.seq}）`;
  if (cardPauseState(db, task.id)?.paused) return "卡已暂停";
  const safety = openSafetyHold(events);
  if (safety) return `安全留证 #${safety.seq} 未处置`;
  const asks = db.query("SELECT id FROM asks WHERE taskId = ? AND state = 'open'").all(task.id) as { id: string }[];
  if (asks.length) return `审批未答：${asks.map((a) => a.id).join("、")}`;
  return null;
}

/** One sample per card + new head + step (recordObserved dedups); the observation plan reads them as this key's evidence. */
export function headSample(db: Database, key: typeof HEAD_REVIEW_KEY, task: Pick<LedgerTask, "project" | "id">, step: string,
  head: string, action: string, data: Record<string, unknown>, now: number): { recorded: boolean; seq: number } {
  return recordObserved(db, { project: task.project, mechanism: key, target: task.id, actionKey: `${step}:${head}`, action, data }, now);
}
