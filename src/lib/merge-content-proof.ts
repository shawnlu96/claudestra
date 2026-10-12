/**
 * PROOF1: versioned content identity + reviewable review / render evidence. The identity hashes scope (repository, card, PR, spec
 * revision, round) with the canonical net diff (review-main-carry-proof.ts netDiff / chain proof) and never a commit id; the evidence
 * keeps approved head, current head and the trusted parent chain for forensics. UI evidence adds renderInputs (scheduler-ui-review-carry
 * .ts), screenshots, the approval seq and strength (UICAR3 scope carry is never full). Pure and injected: no ledger, no switch, no
 * production action — callers own off/observe/on. tests/merge-content-proof.test.ts.
 */
import { createHash } from "node:crypto";
import { gitReader, mainAt, netDiff, originIs, reviewMainCarryProof, type MainCarryProof } from "./review-main-carry-proof.js";
import type { runBounded } from "./run-bounded.js";
import type { GitRead } from "./scheduler-ui-carry-proof.js";
import { renderInputs, type RenderInputs } from "./scheduler-ui-review-carry.js";

const VERSION = 1;
const SHA = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export interface ContentScope { repository: string; taskId: string; pr: number; specRev: number; round: number }
export type ReviewContentEvidence = Readonly<{
  v: 1; kind: "review"; scope: Readonly<ContentScope>; diffHash: string; contentId: string; sourceReviewSeq: number;
  approvedHead: string; currentHead: string; mainHead: string; chain: MainCarryProof["chain"];
}>;
/** full = render inputs read and byte-equal at both heads; scope_carry = UICAR3 kept the approval by scope only. */
type UiStrength = "full" | "scope_carry";
export type UiContentEvidence = Readonly<{
  v: 1; kind: "ui"; review: ReviewContentEvidence; strength: UiStrength; renderInputs: string | null; renderCount: number | null;
  screenshotsDigest: string; approvalSeq: number; renderId: string | null;
}>;
export type ContentRefusal = Readonly<{ ok: false; reason: string; approvedHead?: string; currentHead?: string; mainHead?: string; mainParent?: string }>;
export type ContentVerdict = Readonly<{ ok: true; strength: UiStrength; contentId: string; renderId: string | null }> | ContentRefusal;
/** What the caller knows now. The predicates answer whether that ledger event still stands (not revoked, not superseded). */
export interface ContentFacts {
  scope: ContentScope; currentHead: string; reviewLive: (seq: number) => boolean; approvalLive?: (seq: number) => boolean;
}
type Forensics = Pick<ContentRefusal, "approvedHead" | "currentHead" | "mainHead" | "mainParent">;

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const seqOk = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const countOk = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
function refuse(reason: string, at: Forensics = {}): ContentRefusal {
  const kept = Object.fromEntries(Object.entries(at).filter(([, v]) => typeof v === "string"));
  return Object.freeze({ ok: false, reason, ...kept });
}
function forensics(r: unknown): Forensics {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  return { approvedHead: str(o.approvedHead), currentHead: str(o.currentHead), mainHead: str(o.mainHead) };
}

/** The content identity: repository is case-insensitive like GitHub; no head, main or seq enters it. */
export function contentIdOf(scope: ContentScope, diffHash: string): string {
  return sha256(JSON.stringify(["merge-content-proof", VERSION, scope.repository.toLowerCase(), scope.taskId, scope.pr, scope.specRev,
    scope.round, diffHash]));
}
/** The full render identity: content identity + the render-input tree digest + the screenshots PM approved. */
export function renderIdOf(contentId: string, renderInputsDigest: string, screenshotsDigest: string): string {
  return sha256(JSON.stringify(["merge-render-proof", VERSION, contentId, renderInputsDigest, screenshotsDigest]));
}

function scopeProblem(s: unknown): string | null {
  const o = (s && typeof s === "object" ? s : {}) as Partial<ContentScope>;
  if (typeof o.repository !== "string" || !REPO.test(o.repository)) return "仓库身份无效";
  if (typeof o.taskId !== "string" || !o.taskId) return "卡号无效";
  if (!seqOk(o.pr)) return "PR 号无效";
  if (!countOk(o.specRev) || !countOk(o.round)) return "规格版本或轮次无效";
  return null;
}
/** Shape plus a recomputed identity: a stored record whose digest no longer matches its own fields is not evidence. */
function reviewProblem(r: unknown): string | null {
  if (!r || typeof r !== "object") return "不是内容证据";
  const e = r as ReviewContentEvidence;
  if (e.v !== VERSION || e.kind !== "review") return "不是 v1 审查内容证据";
  const why = scopeProblem(e.scope);
  if (why) return why;
  if (![e.approvedHead, e.currentHead, e.mainHead].every((x) => typeof x === "string" && SHA.test(x))) return "head 不是完整 SHA";
  if (!seqOk(e.sourceReviewSeq) || !Array.isArray(e.chain)) return "源审查 seq 或父链无效";
  if (typeof e.diffHash !== "string" || !HEX64.test(e.diffHash) || e.contentId !== contentIdOf(e.scope, e.diffHash)) return "内容身份摘要对不上";
  return null;
}
function uiProblem(u: UiContentEvidence): string | null {
  if (u.v !== VERSION || u.kind !== "ui") return "不是 v1 UI 内容证据";
  if (typeof u.screenshotsDigest !== "string" || !HEX64.test(u.screenshotsDigest) || !seqOk(u.approvalSeq)) return "截图摘要或批准 seq 无效";
  if (u.strength === "scope_carry") return u.renderInputs === null && u.renderId === null ? null : "范围沿用不能带渲染身份";
  if (u.strength !== "full" || typeof u.renderInputs !== "string" || !HEX64.test(u.renderInputs)) return "渲染输入摘要无效";
  return u.renderId === renderIdOf(u.review.contentId, u.renderInputs, u.screenshotsDigest) ? null : "渲染身份摘要对不上";
}

export interface ReviewEvidenceInput {
  repoDir: string; scope: ContentScope; mainHead: string; approvedHead: string; currentHead: string; sourceReviewSeq: number;
}
/** Read-only. approved == current hashes that head's net diff against actual main; otherwise the canonical ≤16-hop pure-main chain
 * proof must pass. Any git doubt (missing object, cut read, warning, drift) is a refusal that keeps the heads, never evidence. */
export async function reviewContentEvidence(input: ReviewEvidenceInput, command?: typeof runBounded): Promise<ReviewContentEvidence | ContentRefusal> {
  const x = { ...input, scope: { ...input.scope } };
  const at = forensics(x);
  const why = scopeProblem(x.scope) ?? (seqOk(x.sourceReviewSeq) ? null : "源审查 seq 无效")
    ?? ([x.mainHead, x.approvedHead, x.currentHead].every((h) => typeof h === "string" && SHA.test(h)) ? null : "head 不是完整小写 SHA");
  if (why) return refuse(why, at);
  let diffHash: string, chain: MainCarryProof["chain"];
  try {
    if (x.approvedHead !== x.currentHead) {
      const p = await reviewMainCarryProof({ repoDir: x.repoDir, repository: x.scope.repository, base: "main", mainHead: x.mainHead,
        oldHead: x.approvedHead, newHead: x.currentHead }, command);
      if (!p.ok) return refuse(p.reason, { ...at, mainParent: p.mainParent });
      ({ diffHash, chain } = p);
    } else {
      const git = gitReader(x.repoDir, command);
      if (!await originIs(git, x.scope.repository)) return refuse("repoDir 仓库与预期仓库不一致", at);
      if (await mainAt(git) !== x.mainHead) return refuse("actual main 已漂移", at);
      const diff = await netDiff(git, x.mainHead, x.currentHead, true);
      if (await mainAt(git) !== x.mainHead) return refuse("actual main 已漂移", at);
      diffHash = sha256(diff); chain = Object.freeze([]);
    }
  } catch (e) { return refuse(`git 读取失败：${message(e)}`, at); }
  return Object.freeze({ v: VERSION, kind: "review", scope: Object.freeze(x.scope), diffHash, contentId: contentIdOf(x.scope, diffHash),
    sourceReviewSeq: x.sourceReviewSeq, approvedHead: x.approvedHead, currentHead: x.currentHead, mainHead: x.mainHead, chain });
}

export interface UiEvidenceInput {
  review: ReviewContentEvidence; read: GitRead; fileGlobs: readonly string[]; screenshotsDigest: string; approvalSeq: number;
}
/** Full UI evidence only when the render-input trees of the approved and current head are byte-identical (same digest). */
export function uiContentEvidence(x: UiEvidenceInput): UiContentEvidence | ContentRefusal {
  const r = x.review, at = forensics(r);
  const why = reviewProblem(r) ?? (HEX64.test(x.screenshotsDigest) && seqOk(x.approvalSeq) ? null : "截图摘要或批准 seq 无效");
  if (why) return refuse(why, at);
  let before: RenderInputs, after: RenderInputs;
  try {
    before = renderInputs(x.read, r.approvedHead, x.fileGlobs);
    after = r.currentHead === r.approvedHead ? before : renderInputs(x.read, r.currentHead, x.fileGlobs);
  } catch (e) { return refuse(`渲染输入不可核：${message(e)}`, at); }
  if (before.digest !== after.digest || before.count !== after.count) return refuse("批准 head 到当前 head 的渲染输入变了", at);
  return Object.freeze({ v: VERSION, kind: "ui", review: r, strength: "full", renderInputs: after.digest, renderCount: after.count,
    screenshotsDigest: x.screenshotsDigest, approvalSeq: x.approvalSeq, renderId: renderIdOf(r.contentId, after.digest, x.screenshotsDigest) });
}
/** UICAR3 kept the approval by scope only: recorded as such, with no render identity a consumer could mistake for full content. */
export function uiScopeCarryEvidence(x: Omit<UiEvidenceInput, "read" | "fileGlobs">): UiContentEvidence | ContentRefusal {
  const r = x.review;
  const why = reviewProblem(r) ?? (HEX64.test(x.screenshotsDigest) && seqOk(x.approvalSeq) ? null : "截图摘要或批准 seq 无效");
  if (why) return refuse(why, forensics(r));
  return Object.freeze({ v: VERSION, kind: "ui", review: r, strength: "scope_carry", renderInputs: null, renderCount: null,
    screenshotsDigest: x.screenshotsDigest, approvalSeq: x.approvalSeq, renderId: null });
}

function live(check: ((seq: number) => boolean) | undefined, seq: number): boolean {
  try { return check?.(seq) === true; } catch { return false; } // an unreadable ledger answer is "not in force": the evidence just fails closed
}
/** Pure verdict over stored evidence and current facts; only the injected predicates are called. Any change of repository, card,
 * PR, spec revision, round or head, or a revoked review / approval, invalidates. Refusals keep approved / current / main heads. */
export function judgeContentEvidence(ev: ReviewContentEvidence | UiContentEvidence, facts: ContentFacts): ContentVerdict {
  const isUi = !!ev && typeof ev === "object" && (ev as UiContentEvidence).kind === "ui";
  const r = isUi ? (ev as UiContentEvidence).review : ev as ReviewContentEvidence, at = forensics(r);
  const why = reviewProblem(r) ?? (isUi ? uiProblem(ev as UiContentEvidence) : null);
  if (why) return refuse(why, at);
  const s = r.scope, now = facts.scope;
  if (s.repository.toLowerCase() !== now.repository.toLowerCase()) return refuse("仓库身份变了", at);
  if (s.taskId !== now.taskId) return refuse("卡号变了", at);
  if (s.pr !== now.pr) return refuse("PR 变了", at);
  if (s.specRev !== now.specRev) return refuse("规格版本变了", at);
  if (s.round !== now.round) return refuse("轮次变了", at);
  if (r.currentHead !== facts.currentHead) return refuse("当前 head 已不是取证时的 head", at);
  if (!live(facts.reviewLive, r.sourceReviewSeq)) return refuse("源审查已撤销或不再有效", at);
  if (!isUi) return Object.freeze({ ok: true, strength: "full", contentId: r.contentId, renderId: null });
  const u = ev as UiContentEvidence;
  if (!live(facts.approvalLive, u.approvalSeq)) return refuse("截图批准已撤销或不再有效", at);
  return Object.freeze({ ok: true, strength: u.strength, contentId: r.contentId, renderId: u.renderId });
}
/** Only a full verdict is content evidence; a scope carry stays a scope carry. */
export function isFullContentProof(v: ContentVerdict): boolean {
  return v.ok && v.strength === "full";
}
