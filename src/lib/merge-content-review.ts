/**
 * merge-arch-REVIEW1 · writer: turn the merge driver's pure-main carry proof into PROOF1 review evidence (merge-content-proof.ts)
 * and record it under the explicit-key mode (merge-content-review-read.ts mergeContentReviewMode):
 * - off: nothing is read or written.
 * - observe: one `merge_arch_observe` note per (card, source review, head) with the candidate result (would carry and how many
 *   hops, or why not); no projection, so currentReviewFacts answers exactly as before.
 * - on: a scheduler `merge_content_review` event naming the source review by seq, which currentReviewFacts then reads.
 * Only a trusted pure-main chain from the source review's own head with one net diff carries; a delivery, a changed net diff /
 * specRev / round / source review / report / cross-model permission, or an open P0 / P1 refuses and the old path stays. It never
 * writes a PASS: the source review stays the only verdict. tests/merge-content-review*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { contentIdOf, judgeContentEvidence, type ContentScope, type ReviewContentEvidence } from "./merge-content-proof.js";
import { contentModeNow, contentReviewKey, MERGE_ARCH_OBSERVE_OP, MERGE_CONTENT_REVIEW_OP, projectionsOf, setContentModePort } from "./merge-content-review-read.js";
import type { ContentCarry } from "./merge-content-review-sink.js";
import { RECOVERY_POLICY_PATH, readRecoveryFile, type RecoveryMode } from "./recovery-policy.js";
import type { MainCarryProof } from "./review-main-carry-proof.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { exemptVerdict } from "./scheduler-review-swap.js";

export type ContentReviewOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "observed"; carry: boolean; hops: number; reason: string; seq: number; recorded: boolean }
  | { outcome: "projected"; seq: number; duplicate: boolean }
  | { outcome: "refused"; reason: string };
export interface ContentReviewOpts { mode?: RecoveryMode; reportExists?: (path: string) => boolean }
type Chain = MainCarryProof["chain"];

/** The explicit mergeContentReview key only: unset = observe (a project `mode: on` does not act for it); unreadable file = off. */
export function mergeContentReviewMode(project: string, path = RECOVERY_POLICY_PATH): RecoveryMode {
  const r = readRecoveryFile(path);
  if (r.status === "corrupt") return "off";
  const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, project) ? r.data.projects[project] : undefined;
  return cfg?.keys?.mergeContentReview ?? "observe";
}
// The reader (loaded by scheduler-review.ts) cannot import the policy file's module without a cycle: every process that loads
// this writer (the ledger CLI, the scheduler service through the sink) answers its mode read; elsewhere it reads off.
setContentModePort((project) => mergeContentReviewMode(project));

/** owner/repo and number of a GitHub PR URL; null for anything else. */
function prScope(pr: string | null): { repository: string; pr: number } | null {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(pr ?? "");
  return m ? { repository: m[1]!, pr: Number(m[2]) } : null;
}
const latestReview = (events: readonly LedgerEvent[], round: number) => events.findLast((e) => e.kind === "review" && e.data.round === round);

/** The review facts at the source review's own head, or why that review cannot be a source. */
function sourceFacts(db: Database, task: LedgerTask, events: readonly LedgerEvent[], review: LedgerEvent,
  reportExists: (path: string) => boolean): ReviewFacts | string {
  if (events.some((e) => e.seq > review.seq && e.kind === "deliver")) return "源审查之后有交付（人工 push / 改动），走原重审路径";
  const read = currentReviewFacts({ ...task, headSHA: String(review.data.head) }, events);
  if (read.kind !== "facts" || read.facts.eventSeq !== review.seq) return `源审查不是结构化结论：${read.kind === "invalid" ? read.reason : "无"}`;
  const f = read.facts;
  if (f.verdict === "block" || f.findings.some((x) => x.severity === "P0" || x.severity === "P1")) return "源审查还有未关的 P0 / P1";
  if (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2")) return "源审查结论未通过";
  if (!reportExists(f.reportPath)) return "源审查报告不存在";
  const author = remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)?.authorFamily;
  if (f.reviewerFamily === author && !exemptVerdict(db, task, f)) return "跨模型审查权限不成立";
  return f;
}

/**
 * The trusted chain from the source review's head to `head`, read only from scheduler records that name this review by seq
 * (an earlier projection's evidence, or an engine review_carry with its chain); every link must carry the same net diff.
 */
function chainTo(events: readonly LedgerEvent[], review: LedgerEvent, head: string, diffHash: string, depth = 0): Chain | string {
  if (head === review.data.head) return [];
  if (depth > 16) return "沿用链过长";
  const link = events.findLast((e) => e.seq > review.seq && e.kind === "scheduler" && e.actor === "scheduler" && e.data.sourceReviewSeq === review.seq &&
    e.data.to === head && (e.data.op === MERGE_CONTENT_REVIEW_OP || e.data.op === "review_carry"));
  if (!link) return "沿用起点不是源审查 head，也没有点名该审查的可信前一跳";
  if (link.data.diffHash !== diffHash) return "净 diff 与前一跳不一致";
  if (link.data.op === MERGE_CONTENT_REVIEW_OP) return (link.data.evidence as ReviewContentEvidence | undefined)?.chain ?? "前一跳缺证据";
  const before = chainTo(events, review, String(link.data.from), diffHash, depth + 1);
  return typeof before === "string" || !Array.isArray(link.data.chain) ? before : [...before, ...(link.data.chain as Chain)];
}

/** PROOF1 v1 evidence for `carry`, or why none can be built / judged now. */
function evidenceOf(db: Database, task: LedgerTask, carry: ContentCarry, reportExists: (path: string) => boolean): ReviewContentEvidence | string {
  const events = listEvents(db, { project: task.project, target: task.id }), review = latestReview(events, task.round);
  const at = prScope(task.pr);
  if (!review || typeof review.data.head !== "string") return "本轮没有结构化审查";
  if (!at) return "卡的 PR 不是 GitHub PR 链接";
  if (!carry.ok || !carry.mainHead || !carry.diffHash || !carry.chain) return carry.reason || "驱动核对没证明纯 main 更新";
  const src = sourceFacts(db, task, events, review, reportExists);
  if (typeof src === "string") return src;
  const prefix = chainTo(events, review, carry.oldHead, carry.diffHash);
  if (typeof prefix === "string") return prefix;
  if (projectionsOf(events, review.seq).some((e) => e.data.diffHash !== carry.diffHash)) return "净 diff 与先前沿用的不一致";
  const scope: ContentScope = { ...at, taskId: task.id, specRev: task.specRev, round: task.round };
  const ev: ReviewContentEvidence = Object.freeze({ v: 1, kind: "review", scope, diffHash: carry.diffHash, contentId: contentIdOf(scope, carry.diffHash),
    sourceReviewSeq: review.seq, approvedHead: src.head, currentHead: carry.newHead, mainHead: carry.mainHead, chain: [...prefix, ...carry.chain] });
  const v = judgeContentEvidence(ev, { scope, currentHead: carry.newHead, reviewLive: (seq, h) => seq === src.eventSeq && h === src.head });
  return v.ok ? ev : v.reason;
}

function observe(db: Database, ctx: WriteCtx, task: LedgerTask, at: { reviewSeq: number; from: string; to: string; hops: number; diffHash?: string },
  reason: string | null): ContentReviewOutcome {
  const key = `merge-arch-observe:${task.id}:${at.reviewSeq}:${at.to}`, had = getEventByDedup(db, key);
  const text = `内容身份沿用观察：${reason ? `不沿用（${reason}）` : `会沿用审查 #${at.reviewSeq}（${at.hops} 跳）`}`.slice(0, 500);
  const seq = had?.seq ?? insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, { project: task.project, target: task.id, kind: "note", text,
    data: { op: MERGE_ARCH_OBSERVE_OP, mechanism: "mergeContentReview", sourceReviewSeq: at.reviewSeq, from: at.from, to: at.to, hops: at.hops,
      carry: !reason, ...(reason ? { reason: reason.slice(0, 300) } : {}), ...(at.diffHash ? { diffHash: at.diffHash } : {}) } }, true).seq;
  return { outcome: "observed", carry: !reason, hops: at.hops, reason: reason ?? "会沿用", seq, recorded: !had };
}

/**
 * Record one driver carry for its card in one immediate transaction; scheduler identity only. Everything is re-read from the
 * ledger as it is now, so a PM revoke / new review / delivery between the git read and this write refuses.
 */
export function recordContentCarry(db: Database, ctx: WriteCtx, carry: ContentCarry, opts: ContentReviewOpts = {}): ContentReviewOutcome {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "内容身份沿用只许调度服务身份写");
  return tx(db, () => {
    const task = mustTask(db, carry.taskId), mode = opts.mode ?? contentModeNow(task.project);
    if (mode === "off") return { outcome: "skipped", reason: "mergeContentReview 是 off" } as const;
    const review = latestReview(listEvents(db, { project: task.project, target: task.id }), task.round);
    const ev = evidenceOf(db, task, carry, opts.reportExists ?? existsSync), why = typeof ev === "string" ? ev : null;
    const at = { reviewSeq: review?.seq ?? 0, from: String(review?.data.head ?? carry.oldHead), to: carry.newHead,
      hops: typeof ev === "string" ? 0 : ev.chain.length, ...(carry.diffHash ? { diffHash: carry.diffHash } : {}) };
    if (mode === "observe") return observe(db, ctx, task, at, why);
    if (typeof ev === "string") return { outcome: "refused", reason: ev } as const;
    const key = contentReviewKey(task.id, ev.sourceReviewSeq, ev.currentHead), had = getEventByDedup(db, key);
    if (had) return { outcome: "projected", seq: had.seq, duplicate: true } as const;
    const r = review!.data;
    const seq = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `按内容身份沿用审查 #${ev.sourceReviewSeq} 到 ${ev.currentHead.slice(0, 12)}（${at.hops} 跳）`,
      data: { op: MERGE_CONTENT_REVIEW_OP, sourceReviewSeq: ev.sourceReviewSeq, from: ev.approvedHead, to: ev.currentHead, round: task.round,
        specRev: task.specRev, diffHash: ev.diffHash, contentId: ev.contentId, hops: at.hops, reportPath: r.path, reviewer: r.reviewer,
        reviewerSessionId: r.reviewerSessionId, reviewerFamily: r.reviewerFamily, evidence: ev } }, true).seq;
    return { outcome: "projected", seq, duplicate: false } as const;
  });
}
