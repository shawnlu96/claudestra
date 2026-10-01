/**
 * Review convergence (i28-CONV1), pure. Before the planner reads a verdict, P1s that do not hang on an acceptance line (or a
 * regression) count as P2, and from round SCOPE_ROUND a P1 that is new, not a regression and outside the files the last fix
 * touched counts as P2 too: rounds stop growing because each reviewer digs somewhere new. The real stop is the round cap: at
 * MAX_REVIEW_ROUND a remaining P1 holds the card (no new work, mode stays auto) until PM resumes it. tests/review-converge.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import { findingBasis } from "./review-converge-basis.js";
import { countsAsP1, normalizedFamily, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";

/** From this round the review covers only the fix diff plus last round's open findings (review-converge-order.ts says so). */
export const SCOPE_ROUND = 3;
/** The one safety valve: a P1 still standing in this round (or later) holds the card for PM. */
export const MAX_REVIEW_ROUND = 8;
export const ROUND_CAP_CODE = "review_round_cap";

/** Files changed between the head reviewed last round and this round's head (review-converge-scope.ts computes it). */
export interface FixDiff { from: string; to: string; files: string[] }
export type DowngradeWhy = "no_basis" | "outside_diff";
export interface DowngradeItem { findingId: string; family: string; probe: string; why: DowngradeWhy }
/** What one round's convergence demoted; rides on the stage intent so the move and its record land in one transaction. */
export interface Downgrade { round: number; head: string; reportPath: string; items: DowngradeItem[] }

/** The head the previous round reviewed: the fix diff starts there. */
export function prevReviewedHead(events: readonly LedgerEvent[], round: number): string | null {
  const e = events.findLast((x) => x.kind === "review" && typeof x.data.round === "number" && x.data.round < round && typeof x.data.head === "string");
  return e ? e.data.head as string : null;
}

/** Last round's findings that still block (named a basis, not demoted then): this round may re-check them anywhere. */
function prevOpen(events: readonly LedgerEvent[], round: number): ReviewFinding[] {
  const e = events.findLast((x) => x.kind === "review" && x.data.round === round - 1 && Array.isArray(x.data.findings));
  const rows = (e?.data.findings ?? []) as ReviewFinding[];
  return rows.filter((f) => f && typeof f === "object" && countsAsP1(events, round - 1, f));
}

const PATH_TOKEN = /(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][\w]{0,7}/g;

/** File-looking tokens in a probe (`src/a.ts:12` → `src/a.ts`). */
export function probePaths(probe: string): string[] {
  return [...new Set((probe.match(PATH_TOKEN) ?? []).map((t) => t.replace(/^\.\//, "")))];
}

/** A probe touches the diff when one of its paths names a changed file (either may be the shorter, repo-relative one). */
export function touchesDiff(probe: string, files: readonly string[]): boolean {
  const paths = probePaths(probe);
  return paths.some((p) => files.some((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`)));
}

/**
 * The verdict as the planner should weigh it. Only P1 changes; P0 / P2 and the stored event stay as written.
 * A diff that does not span last round's head → this round's head (or none at all) demotes nothing on scope: keep the P1.
 */
export function convergeFindings(events: readonly LedgerEvent[], facts: Pick<ReviewFacts, "round" | "head" | "findings">,
  diff: FixDiff | null | undefined): { findings: ReviewFinding[]; items: DowngradeItem[] } {
  const scoped = facts.round >= SCOPE_ROUND && !!diff && diff.to === facts.head && diff.from === prevReviewedHead(events, facts.round);
  const open = scoped ? prevOpen(events, facts.round) : [];
  const isOpen = (f: ReviewFinding) => open.some((o) => o.findingId === f.findingId || normalizedFamily(o.family) === normalizedFamily(f.family));
  const items: DowngradeItem[] = [];
  const findings = facts.findings.map((f) => {
    if (f.severity !== "P1") return f;
    const basis = findingBasis(f);
    const why: DowngradeWhy | null = !basis ? "no_basis"
      : scoped && basis !== "regression" && !isOpen(f) && !touchesDiff(f.probe, diff!.files) ? "outside_diff" : null;
    if (!why) return basis === f.basis || !basis ? f : { ...f, basis };
    items.push({ findingId: f.findingId, family: f.family, probe: f.probe, why });
    return { ...f, severity: "P2" as const };
  });
  return { findings, items };
}

/** Facts with converged findings, plus the record to write when the planner acts on them (null = nothing demoted). */
export function convergeReview(events: readonly LedgerEvent[], facts: ReviewFacts, diff: FixDiff | null | undefined): { facts: ReviewFacts; downgrade: Downgrade | null } {
  const c = convergeFindings(events, facts, diff);
  return { facts: { ...facts, findings: c.findings },
    downgrade: c.items.length ? { round: facts.round, head: facts.head, reportPath: facts.reportPath, items: c.items } : null };
}

/** PM handed the card back (`workflow-resume`, manual) after this verdict: the cap has been seen and released for this round. */
const resumedAfter = (events: readonly LedgerEvent[], seq: number): boolean =>
  events.some((e) => e.seq > seq && e.kind === "scheduler" && e.data.op === "workflow_resume" && e.data.manual === true);

/** The round cap: a blocking P1 at MAX_REVIEW_ROUND or later holds the card until PM resumes it; null = go on. */
export function roundCap(events: readonly LedgerEvent[], facts: Pick<ReviewFacts, "round" | "eventSeq">): { code: string; reason: string } | null {
  if (facts.round < MAX_REVIEW_ROUND || resumedAfter(events, facts.eventSeq)) return null;
  return { code: ROUND_CAP_CODE, reason: `第 ${facts.round} 轮仍有挂验收线的 P1（上限 ${MAX_REVIEW_ROUND} 轮）：卡停下等 PM 拆卡或改规格后 workflow-resume` };
}

/** The line a fix order carries about what happens next under these rules; null when nothing is close. */
export function fixWarning(streakMax: number, round: number, fallback: string): string | null {
  const lines = [
    ...(streakMax === 2 ? [`同一条 P1 已连续 2 轮：第 3 轮还在就退到：${fallback}`] : []),
    ...(round >= MAX_REVIEW_ROUND - 1 ? [`已到第 ${round} 轮：第 ${MAX_REVIEW_ROUND} 轮仍有挂验收线的 P1 就停下交 PM（拆卡或改规格）`] : []),
  ];
  return lines.length ? lines.join("；") : null;
}
