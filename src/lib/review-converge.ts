/**
 * Review convergence (i28-CONV1), pure. Before the planner reads a verdict, P1s that do not hang on an acceptance line (or a
 * regression) count as P2, and from round SCOPE_ROUND a P1 that is new, not a regression and outside the files the last fix
 * touched counts as P2 too: rounds stop growing because each reviewer digs somewhere new. The real stop is the round cap: at
 * MAX_REVIEW_ROUND a remaining P1 holds the card (no new work, mode stays auto) until PM resumes it. tests/review-converge.test.ts.
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { findingBasis, nearFindingLine, type FindingBasis } from "./review-converge-basis.js";
import { currentReviewFacts, countsAsP1, downgradedIds, normalizedFamily, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";

/** From this round the review covers only the fix diff plus last round's open findings (review-converge-order.ts says so). */
export const SCOPE_ROUND = 3;
/** The one safety valve: a P1 still standing in this round (or later) holds the card for PM. */
export const MAX_REVIEW_ROUND = 8;
export const ROUND_CAP_CODE = "review_round_cap";

/** Files changed between the head reviewed last round and this round's head (review-converge-scope.ts computes it). */
export interface FixDiff { from: string; to: string; files: string[] }
type DowngradeWhy = "no_basis" | "outside_diff";
export interface DowngradeItem { findingId: string; family: string; probe: string; why: DowngradeWhy }
/** A P1 whose only marker is near (i28-CONV6), under nearMarker observe / on; counted = it stayed a P1 on that line. */
export interface NearItem { findingId: string; basis: FindingBasis; mode: "observe" | "on"; counted: boolean }
/**
 * What one round's convergence demoted; rides on the stage intent so the move and its record land in one transaction.
 * near is absent under off (the old record, byte for byte); under on it may be the only content (items empty).
 */
export interface Downgrade { round: number; head: string; reportPath: string; items: DowngradeItem[]; near?: NearItem[] }

/** recovery-policy nearMarker for the card's project; read only when a no-basis P1 carries a near marker. */
export type NearModePort = (project: string) => RecoveryMode;
const nearModeOf: NearModePort = (project) => recoveryPolicy(project, "nearMarker").mode;

/** The event line PM greps for during observe (「近似标记」), shared by both modes. */
export function nearText(n: NearItem): string {
  const tail = n.mode === "observe" ? "on 时会按 P1 计" : n.counted ? "已按 P1 计" : "已按 P1 计，但不在本轮修复改动内，仍降为 P2";
  return `近似标记：${n.findingId} 依据 ${n.basis}，${tail}`;
}

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

const PATH_TOKEN = /(?:[\p{L}\p{N}_@.-]+\/)+[\p{L}\p{N}_@.-]+|[\p{L}\p{N}_@-][\p{L}\p{N}_@.-]*\.[A-Za-z][\w]{0,7}/gu;

/** File-looking tokens in a probe (`src/a.ts:12` → `src/a.ts`). */
export function probePaths(probe: string): string[] {
  return [...new Set((probe.match(PATH_TOKEN) ?? []).map((t) => t.replace(/^\.\//, "")))];
}

/** A probe touches the diff when one of its paths names a changed file (either may be the shorter, repo-relative one). */
export function touchesDiff(probe: string, files: readonly string[]): boolean {
  const literal = files.some((f) => {
    const path = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}_@.-])${path}(?![\\p{L}\\p{N}_@./-])`, "u").test(probe);
  });
  const paths = probePaths(probe);
  return literal || paths.some((p) => files.some((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`)));
}

/**
 * The verdict as the planner should weigh it. Only P1 changes; P0 / P2 and the stored event stay as written.
 * A diff that does not span last round's head → this round's head (or none at all) demotes nothing on scope: keep the P1.
 */
export function convergeFindings(events: readonly LedgerEvent[], facts: Pick<ReviewFacts, "round" | "head" | "findings">,
  diff: FixDiff | null | undefined, nearPort: NearModePort = nearModeOf): { findings: ReviewFinding[]; items: DowngradeItem[]; near: NearItem[] } {
  const scoped = facts.round >= SCOPE_ROUND && !!diff && diff.to === facts.head && diff.from === prevReviewedHead(events, facts.round);
  const open = scoped ? prevOpen(events, facts.round) : [];
  const isOpen = (f: ReviewFinding) => open.some((o) => o.findingId === f.findingId || normalizedFamily(o.family) === normalizedFamily(f.family));
  const recorded = downgradedIds(events, facts.round);
  const items: DowngradeItem[] = [], near: NearItem[] = [];
  let mode: RecoveryMode | undefined;
  const nearMode = () => mode ??= nearModeFor(events, nearPort);
  const described = (id: string) => storedDescription(events, facts, id);
  const findings = facts.findings.map((f) => {
    if (f.severity !== "P1") return f;
    if (recorded.has(f.findingId)) return { ...f, severity: "P2" as const };
    const strict = findingBasis(f), line = strict ? null : nearFindingLine({ ...f, description: f.description ?? described(f.findingId) });
    const nb: FindingBasis | null = line === null ? null : `acceptance:${line}`;
    const m = nb ? nearMode() : "off";
    const basis = strict ?? (m === "on" ? nb : null);
    const why: DowngradeWhy | null = !basis ? "no_basis"
      : scoped && basis !== "regression" && !isOpen(f) && !touchesDiff(f.probe, diff!.files) ? "outside_diff" : null;
    if (nb && m !== "off") near.push({ findingId: f.findingId, basis: nb, mode: m, counted: !why });
    if (!why) return strict || !basis ? f : { ...f, basis };
    items.push({ findingId: f.findingId, family: f.family, probe: f.probe, why });
    return { ...f, severity: "P2" as const };
  });
  return { findings, items, near };
}

/** ReviewFacts drop the wire description (scheduler-review.ts findingsOf); the stored review event still has it. */
function storedDescription(events: readonly LedgerEvent[], facts: Pick<ReviewFacts, "round" | "head">, id: string): string | undefined {
  const e = events.findLast((x) => x.kind === "review" && x.data.round === facts.round && x.data.head === facts.head);
  const raw = Array.isArray(e?.data.findings) ? (e.data.findings as unknown[]).find((r) => (r as { findingId?: unknown })?.findingId === id) : undefined;
  const d = (raw as { description?: unknown } | undefined)?.description;
  return typeof d === "string" ? d : undefined;
}

/** The switch for this card's project (every event of a task carries it); none known, or a port that throws, is off. */
function nearModeFor(events: readonly LedgerEvent[], port: NearModePort): RecoveryMode {
  const project = events.find((e) => e.kind === "review")?.project ?? events[0]?.project;
  if (!project) return "off";
  try {
    return port(project);
  } catch (e) {
    console.error(`⚠️ [review-converge] ${project} 读 nearMarker 开关失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

/** Facts with converged findings, plus the record to write when the planner acts on them (null = nothing demoted, no near marker). */
export function convergeReview(events: readonly LedgerEvent[], facts: ReviewFacts, diff: FixDiff | null | undefined,
  nearPort?: NearModePort): { facts: ReviewFacts; downgrade: Downgrade | null } {
  const c = convergeFindings(events, facts, diff, nearPort);
  return { facts: { ...facts, findings: c.findings }, downgrade: c.items.length || c.near.length
    ? { round: facts.round, head: facts.head, reportPath: facts.reportPath, items: c.items, ...(c.near.length ? { near: c.near } : {}) } : null };
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

/** Only validated review exits carry demotions; identity/history errors must never legitimize an invalid verdict. */
export function escalationDowngrade<T extends { kind: string; code?: string; reviewSeq?: number }>(decision: T,
  task: Pick<LedgerTask, "round" | "headSHA" | "specRev">, events: readonly LedgerEvent[], diff?: FixDiff | null): T & { downgrade?: Downgrade } {
  if (decision.kind !== "escalate" || !["three_p1_rounds", "review_block"].includes(decision.code ?? "")) return decision;
  const read = currentReviewFacts(task, events);
  if (read.kind !== "facts" || read.facts.eventSeq !== decision.reviewSeq) return decision;
  const { downgrade } = convergeReview(events, read.facts, diff);
  return downgrade ? { ...decision, downgrade } : decision;
}
