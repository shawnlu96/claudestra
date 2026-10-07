import { normalizedFamily } from "./review-arbiter-identity.js";
import { arbitratedFacts, arbitrationKeepsP1 } from "./review-arbiter.js";
/** Structured review evidence used by the deterministic planner; free-form report text cannot decide a branch. */
import type { LedgerEvent, LedgerTask, ReviewVerdict } from "./ledger-stages.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { LedgerError } from "./ledger-store.js";
import { basisField, findingBasis, type FindingBasis } from "./review-converge-basis.js";
import { deliveredHead } from "./scheduler-review-rebase.js";

type FindingSeverity = "P0" | "P1" | "P2";
/** `basis` is optional: verdicts that predate it (or carry only text markers) still parse; review-converge-basis.ts resolves both. */
export interface ReviewFinding { findingId: string; family: string; severity: FindingSeverity; probe: string; basis?: FindingBasis; pitfall?: true;
  /** The reviewer's own description as the MCP verdict carried it (dispatch-recovery-MATW); older records and CLI rows have none. */
  description?: string }
export interface ReviewFacts {
  eventSeq: number;
  round: number;
  head: string;
  verdict: ReviewVerdict;
  reviewer: string;
  reviewerSessionId: string;
  reviewerFamily: AuthorFamily;
  reportPath: string;
  findings: ReviewFinding[];
}
export type ReviewRead = { kind: "none" } | { kind: "invalid"; reason: string } | { kind: "facts"; facts: ReviewFacts };

const count = (v: unknown): number | null => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
const str = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const familyName = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,64}$/.test(v);

function findingsOf(value: unknown): ReviewFinding[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const rows: ReviewFinding[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const findingId = str(r.findingId);
    if (!findingId || !/^[\w.-]{1,80}$/.test(findingId) || ids.has(findingId) || !familyName(r.family) ||
      !["P0", "P1", "P2"].includes(String(r.severity)) || !str(r.probe) || (r.probe as string).length > 4000) return null;
    if (r.basis !== undefined && r.basis !== null && !basisField(r.basis)) return null;
    if (r.pitfall !== undefined && (typeof r.pitfall !== "boolean" || r.pitfall && r.severity !== "P1")) return null;
    ids.add(findingId);
    const basis = findingBasis({ findingId, family: r.family, probe: r.probe as string, basis: r.basis,
      description: typeof r.description === "string" ? r.description : undefined });
    rows.push({ findingId, family: r.family, severity: r.severity as FindingSeverity, probe: r.probe as string,
      ...(basis && (r.basis || r.description) ? { basis } : {}), ...(r.pitfall ? { pitfall: true as const } : {}) });
  }
  return rows;
}

export interface StructuredReviewFields {
  head?: string;
  reviewerSessionId?: string;
  reviewerFamily?: AuthorFamily;
  findings?: ReviewFinding[];
}

/**
 * A structured review is all-or-nothing and must agree with itself before it can drive the planner; a partial one
 * would read as "invalid" later and stop an auto card, so it is refused at write time instead. Legacy reviews omit all.
 */
export function checkStructuredReview(input: StructuredReviewFields & { p0: number; p1: number; p2: number; path?: string }, task: Pick<LedgerTask, "headSHA">): void {
  const given = [input.head, input.reviewerSessionId, input.reviewerFamily, input.findings].filter((v) => v !== undefined).length;
  if (given === 0) return;
  if (given < 4 || !input.path) throw new LedgerError("invalid", "结构化审查要同时带 head、审查 session、模型家族、逐项结论和报告路径");
  if (!/^[a-f0-9]{40}$/i.test(input.head as string) || input.head !== task.headSHA) throw new LedgerError("invalid", "结构化审查的完整 head 与任务当前 head 不一致");
  if (!str(input.reviewerSessionId) || (input.reviewerSessionId as string).length > 200 || /[\p{Cc}\p{Cf}]/u.test(input.reviewerSessionId as string)) {
    throw new LedgerError("invalid", "审查 session id 要是单行且不超过 200 字");
  }
  if (!["claude", "codex"].includes(input.reviewerFamily as string)) throw new LedgerError("invalid", "审查模型家族只认 claude / codex");
  const rows = findingsOf(input.findings);
  if (!rows) throw new LedgerError("invalid", "逐项结论要有 findingId、family、severity、probe，且 findingId 不重复");
  if ((["P0", "P1", "P2"] as const).some((p) => rows.filter((f) => f.severity === p).length !== input[p.toLowerCase() as "p0" | "p1" | "p2"])) {
    throw new LedgerError("invalid", "P0/P1/P2 计数与逐项结论不一致");
  }
}

type ReviewTask = Pick<LedgerTask, "round" | "headSHA" | "specRev">;
const SHA = /^[a-f0-9]{40}$/i;

/**
 * The head a review still covers after update-branch merged main in. Only carries the merge journal wrote count
 * (scheduler-merge.ts carryReview: actor scheduler, its merge_phase event next in the same transaction); each must start
 * where the previous one ended, in this round and spec revision, with no delivery after the review. Anything else: null.
 * With `mayCarry` (MCRY1) a formal PM `review_main_carry` (review-main-carry-manual.ts) counts too: by an actor it accepts (a project
 * PM / master / owner), complete, under its own key, naming this review, right after its own head move. Without it they are not read.
 */
function carriedHead(task: ReviewTask, events: readonly LedgerEvent[], review: LedgerEvent, head: string, mayCarry?: (actor: string) => boolean): string | null {
  const after = events.filter((e) => e.seq > review.seq);
  if (after.some((e) => e.kind === "deliver")) return null;
  let at = head;
  for (const c of after.filter((e) => (e.kind === "scheduler" && e.data.op === "review_carry" && e.actor === "scheduler") ||
    (!!mayCarry && e.kind === "decision" && e.data.op === "review_main_carry"))) {
    const paired = c.kind === "decision" ? mayCarry!(c.actor) && c.data.sourceReviewSeq === review.seq && typeof c.data.mainHead === "string" &&
      SHA.test(c.data.mainHead) && /^[a-f0-9]{64}$/.test(String(c.data.diffHash)) && c.dedupKey === `main-carry:${c.target}:${String(c.data.from)}:${String(c.data.to)}` &&
      after.some((e) => e.seq === c.seq - 1 && e.kind === "task" && e.actor === c.actor && (e.data.patch as { headSHA?: unknown } | undefined)?.headSHA === c.data.to)
      : after.some((e) => e.seq === c.seq + 1 && e.kind === "scheduler" && e.actor === "scheduler" &&
      e.data.op === "merge_phase" && e.data.carrySeq === c.seq && e.data.intentId === c.data.intentId && e.data.to === "await_ci");
    const to = str(c.data.to);
    if (!paired || c.data.from !== at || !to || !SHA.test(to) || c.data.round !== task.round || c.data.specRev !== task.specRev) return null;
    at = to;
  }
  return at;
}

/** Only this round and head may drive the current review branch; a stale report is a hard stop. */
export function currentReviewFacts(task: ReviewTask, events: readonly LedgerEvent[], mayCarry?: (actor: string) => boolean): ReviewRead {
  const review = events.findLast((e) => e.kind === "review" && e.data.round === task.round);
  if (!review) return { kind: "none" };
  const d = review.data;
  const head = str(d.head), verdict = str(d.verdict), reviewer = str(d.reviewer);
  const reviewerSessionId = str(d.reviewerSessionId), reviewerFamily = str(d.reviewerFamily), reportPath = str(d.path);
  const findings = findingsOf(d.findings);
  if (!head || !SHA.test(head) || (head !== task.headSHA && carriedHead(task, events, review, head, mayCarry) !== task.headSHA)) {
    return { kind: "invalid", reason: "审查结论的完整 head 与任务不一致" };
  }
  if (!verdict || !["pass", "changes", "block"].includes(verdict) || !reviewer || !reviewerSessionId ||
    !reviewerFamily || !["claude", "codex"].includes(reviewerFamily) || !reportPath || !findings) {
    return { kind: "invalid", reason: "审查结论缺结构化字段或报告路径" };
  }
  const counts = ["P0", "P1", "P2"].map((p) => findings.filter((f) => f.severity === p).length);
  if ([d.p0, d.p1, d.p2].some((v, i) => count(v) !== counts[i])) return { kind: "invalid", reason: "P0/P1/P2 计数与逐项结论不一致" };
  const demoted = downgradedIds(events, task.round);
  return {
    kind: "facts",
    facts: arbitratedFacts(events, task.specRev, { eventSeq: review.seq, round: task.round, head, verdict: verdict as ReviewVerdict, reviewer,
      reviewerSessionId, reviewerFamily: reviewerFamily as AuthorFamily, reportPath,
      findings: findings.map((f) => f.severity === "P1" && demoted.has(f.findingId) ? { ...f, severity: "P2" } : f) }),
  };
}

export { normalizedFamily } from "./review-arbiter-identity.js";

/** The planner's record of P1s it treated as P2 in a round (review-converge-followup.ts writes it with the stage move). */
export const DOWNGRADE_OP = "review_downgrade";
export function downgradedIds(events: readonly LedgerEvent[], round: number): Set<string> {
  const ids = events.filter((e) => e.kind === "scheduler" && e.data.op === DOWNGRADE_OP && e.data.round === round)
    .flatMap((e) => Array.isArray(e.data.findingIds) ? e.data.findingIds.filter((x): x is string => typeof x === "string") : []);
  return new Set(ids);
}
/** A P1 that still blocks in its own round: it names a basis and the planner did not downgrade it then (review-converge.ts). */
export const countsAsP1 = (events: readonly LedgerEvent[], round: number, f: ReviewFinding): boolean =>
  f.severity === "P1" && arbitrationKeepsP1(events, f, round) && findingBasis(f) !== null && !downgradedIds(events, round).has(f.findingId);

function p1RowsByRound(events: readonly LedgerEvent[], currentRound: number, minRound: number): Map<number, ReviewFinding[] | null> {
  const byRound = new Map<number, LedgerEvent>();
  for (const e of events) if (e.kind === "review" && typeof e.data.round === "number" && e.data.round <= currentRound) byRound.set(e.data.round, e);
  const rowsByRound = new Map<number, ReviewFinding[] | null>();
  for (let round = minRound; round <= currentRound; round++) {
    const e = byRound.get(round);
    const rows = findingsOf(e?.data.findings);
    if (!e || !rows) { rowsByRound.set(round, null); continue; }
    const head = str(e.data.head);
    // A driver head change (merge-driver movedHead) stands in for the deliver of its round: scheduler-review-rebase.ts.
    if (!head || !/^[a-f0-9]{40}$/i.test(head) || deliveredHead(events, e) !== head ||
      ["P0", "P1", "P2"].some((p) => count(e.data[p.toLowerCase()]) !== rows.filter((f) => f.severity === p).length)) {
      rowsByRound.set(round, null);
      continue;
    }
    rowsByRound.set(round, rows);
  }
  return rowsByRound;
}

function consecutiveP1(events: readonly LedgerEvent[], currentRound: number, minRound: number,
  match: (finding: ReviewFinding) => boolean): number | null {
  const byRound = p1RowsByRound(events, currentRound, minRound);
  let streak = 0;
  for (let round = currentRound; round >= minRound; round--) {
    const rows = byRound.get(round);
    if (!rows) return null;
    if (!rows.some((f) => countsAsP1(events, round, f) && match(f))) break;
    streak++;
  }
  return streak;
}

/** A finding keeps its identity across a renamed family; normalized family is the fallback match. */
export function p1FindingStreak(events: readonly LedgerEvent[], finding: Pick<ReviewFinding, "findingId" | "family">,
  currentRound: number, minRound = 1): number | null {
  const family = normalizedFamily(finding.family);
  return consecutiveP1(events, currentRound, minRound,
    (row) => row.findingId === finding.findingId || normalizedFamily(row.family) === family);
}

/** Consecutive rounds with any blocking P1; the planner only uses it to prove every round's evidence is intact (null = not). */
export function p1AnyStreak(events: readonly LedgerEvent[], currentRound: number, minRound = 1): number | null {
  return consecutiveP1(events, currentRound, minRound, () => true);
}
