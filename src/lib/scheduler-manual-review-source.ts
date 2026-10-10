/**
 * dispatch-recovery-AUTOACK1 · a PM hand-back (`ledger workflow-resume`, PM identity only) may carry the card's current, complete manual
 * review into auto. One source only: a review the PM put in the lend pool (`ledger lend-offer`) and a peer answered with the full
 * signed chain (claim → B's own take_review / submit_verdict ticket → A's signed receipt → the archived received request), checked by
 * the same pool proof the formal main carry uses (poolReviewRefusal, pmOffered). A local manual MCP verdict is not adopted: the ledger
 * keeps no take_review record nor the reviewer's checkout / head at review time, so its independence cannot be checked — it stays in
 * the manual merge queue, as do PM-recorded / CLI-copied reports, self or author reviews, same-family verdicts outside a current
 * exemption, P0/P1, another head / spec / round, a security card whose reviews stay local, and a live order / lease / newer review.
 * The adoption is its own scheduler event naming the original order and verdict (category manual); it never writes an intent, ack or
 * session bind. Valid only for the workflow rev the resume set and while the adopting PM keeps the project's rights.
 * One predicate (adoptedReviewSource) re-proves it everywhere: the resume, the planner snapshot (scheduler-auto-snapshot.ts) and both
 * merge gates. tests/scheduler-manual-review-source*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WriteCtx } from "./ledger-checks.js";
import { heldLease } from "./ledger-lend-lease.js";
import type { AuthorFamily, TaskWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { listRequests, revokeOf } from "./manual-merge-queue-facts.js";
import { claimsPoolReview, poolReviewRefusal } from "./pool-review-proof.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { openSafetyHold } from "./scheduler-review-swap.js";
import { securityPoolMode, securityReviewLocalOnly } from "./security-pool.js";

export const ADOPT_OP = "manual_review_adopt";
/** What an adoption event records: the original verdict / PM order, never a new one. `offerSeq` = the PM's lend-offer note. */
export interface AdoptedSource {
  kind: "manual_peer"; reviewSeq: number; orderId: string; reviewer: string; sessionId: string; family: AuthorFamily;
  head: string; round: number; specRev: number; reportPath: string; offerSeq: number;
}
/** The planner's copy (PlannerSnapshot.adoptedSource): the full ledger re-proof autoSnapshot ran, never re-derived from events. */
type AdoptedRef = Pick<AdoptedSource, "reviewSeq" | "reviewer" | "sessionId" | "family">;

const MODE_OPS: readonly string[] = ["workflow", "workflow_resume", "fallback_manual"];
const REVIEW_STEPS: readonly string[] = ["review", "final_review"];
const WRITE_STEPS: readonly string[] = ["write", "fix"];
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const modeEvent = (e: LedgerEvent): boolean => e.kind === "scheduler" && MODE_OPS.includes(String(e.data.op));
const manualMode = (e: LedgerEvent | undefined): boolean =>
  !!e && (e.data.op === "fallback_manual" || (e.data.op === "workflow" && e.data.mode === "manual"));
const reviewOffer = (e: LedgerEvent): boolean => e.kind === "note" && obj(e.data.lend)?.op === "offer" && obj(e.data.lend)?.step === "review";

/** A review sent after the verdict (a review / final_review step assigned, or a review put in the pool): it may be running, the verdict is not the current one. */
const superseded = (events: readonly LedgerEvent[], reviewSeq: number): boolean => events.some((e) => e.seq > reviewSeq &&
  ((e.kind === "step" && e.data.op === "assign" && REVIEW_STEPS.includes(String(e.data.step))) || reviewOffer(e)));

export interface SourceDeps { reportOk?: (path: string) => boolean }
const reportFile = (path: string): boolean => {
  try { const st = statSync(path); return isAbsolute(path) && st.isFile() && st.size > 0; } catch { return false; } // missing = the material cannot be checked
};

/**
 * Everything the verdict itself must prove, against the ledger: this round / spec's review window, written while the card was manual
 * (no mode change between it and `until`), a passing verdict by no author, no review after it, and the PM's pool order with its full
 * signed ticket chain. A string says why not.
 */
function sourceRefusal(db: Database, task: LedgerTask, workflow: TaskWorkflow, f: ReviewFacts, events: readonly LedgerEvent[], until: number,
  deps: SourceDeps): AdoptedSource | string {
  const ev = events.find((e) => e.seq === f.eventSeq);
  if (!ev || ev.kind !== "review" || ev.data.round !== task.round) return "审查事件不在本轮";
  const entered = events.findLast((e) => e.seq < ev.seq && e.kind === "stage" && e.data.to === "review");
  if (!entered || entered.data.round !== task.round || entered.data.specRev !== task.specRev) return "审查不在本轮、当前规格版本的 review 窗口里";
  if (!manualMode(events.findLast((e) => e.seq < ev.seq && modeEvent(e))) || events.some((e) => e.seq > ev.seq && e.seq < until && modeEvent(e))) {
    return "审查不是这段人工期间写的（之后流程又变过）";
  }
  if (f.verdict === "block" || f.findings.some((x) => x.severity === "P0" || x.severity === "P1") || (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2"))) {
    return "审查结论未通过（有 P0 / P1 或 block），不承接";
  }
  if (f.reviewer === task.agent || events.some((e) => e.kind === "step" && e.data.op === "assign" && WRITE_STEPS.includes(String(e.data.step)) && e.data.executor === f.reviewer)) {
    return "审查人写过本卡代码（作者兼审）";
  }
  const lend = obj(ev.data.lend);
  if (!lend && !claimsPoolReview({ reviewer: f.reviewer, session: f.reviewerSessionId })) {
    return "不是 PM 挂池、对方经 take_review / submit_verdict 签票据交回的结论（本机人工结论台账没有可核的领单与独立检出证据；PM 代记、CLI 复制同样没有），继续人工合并队列";
  }
  if (superseded(events, ev.seq)) return "结论之后又派了新的审查，可能有审查在跑";
  const hold = openSafetyHold(events);
  if (hold) return `安全留证 #${hold.seq} 未处置`;
  if (securityReviewLocalOnly(workflow, securityPoolMode(task.project))) return "security 卡审查只在本机，池单结论不承接";
  // The PM order's whole chain (offer note, claim, B's ticket, signed receipt, archived request) and the family / exemption rule.
  const pool = poolReviewRefusal(db, task, workflow, f, { pmOffered: true });
  if (pool) return pool;
  const orderId = String(lend!.orderId);
  const offer = events.findLast((e) => e.seq < ev.seq && reviewOffer(e) && obj(e.data.lend)?.orderId === orderId);
  if (!offer) return `出借单 ${orderId} 缺 PM 挂单记录`;
  if (!(deps.reportOk ?? reportFile)(f.reportPath)) return "原审查报告读不到，材料无法核";
  return { kind: "manual_peer", reviewSeq: ev.seq, orderId, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily,
    head: f.head, round: task.round, specRev: task.specRev, reportPath: f.reportPath, offerSeq: offer.seq };
}

const sameSource = (d: Record<string, unknown>, s: AdoptedSource): boolean =>
  d.reviewSeq === s.reviewSeq && d.kind === s.kind && d.orderId === s.orderId && d.reviewer === s.reviewer && d.sessionId === s.sessionId &&
  d.family === s.family && d.head === s.head && d.reportPath === s.reportPath && d.round === s.round && d.specRev === s.specRev &&
  d.offerSeq === s.offerSeq && d.category === "manual";

/** The current round's verdict (main carries as the merge gate reads them), or null when there is none to adopt. */
function currentFacts(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): ReviewFacts | string | null {
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  return read.kind === "facts" ? read.facts : read.kind === "none" ? null : read.reason;
}

/** Work or receipts still out on the card: an adoption would overwrite them. */
function liveRefusal(db: Database, task: LedgerTask): string | null {
  const open = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('submitted','unknown')").all(task.id) as { id: string }[];
  if (open.length) return `调度意图 ${open.map((o) => o.id).join("、")} 结果未定`;
  const lend = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()
    ? db.query("SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')").all(task.id) as { orderId: string }[] : [];
  if (lend.length) return `出借单 ${lend.map((o) => o.orderId).join("、")} 仍在途`;
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_write_leases'").get() && heldLease(db, task)) return "写租约仍被持有";
  const queued = listRequests(db, task.project, task.id).find((r) => !revokeOf(db, r));
  if (queued) return `已有人工合并请求 #${queued.seq}，不重复恢复`;
  return null;
}

export type ResumeSource = { ok: true; source: AdoptedSource } | { ok: false; why: string; reviewSeq: number | null };

/** Inside the PM resume transaction, before it settles pool orders: the source this hand-back would adopt, or why not. null = no verdict. */
export function resumeReviewSource(db: Database, ctx: WriteCtx, task: LedgerTask, workflow: TaskWorkflow, deps: SourceDeps = {}): ResumeSource | null {
  if (ctx.actor === "scheduler" || !actorMayConfigure(db, ctx.actor, task.project) || !["review", "merge"].includes(task.stage)) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  const f = currentFacts(db, task, events);
  if (f === null) return null;
  if (typeof f === "string") return { ok: false, why: f, reviewSeq: null };
  if (f.reviewer === ctx.actor) return { ok: false, why: "交回人不能承接自己的审查", reviewSeq: f.eventSeq };
  const s = sourceRefusal(db, task, workflow, f, events, Infinity, deps);
  if (typeof s === "string") return { ok: false, why: s, reviewSeq: f.eventSeq };
  const live = liveRefusal(db, task);
  return live ? { ok: false, why: live, reviewSeq: f.eventSeq } : { ok: true, source: s };
}

/** The adoption event the resume writer inserts (it owns the transaction and the write), or null when nothing is adopted. */
export function adoptionEvent(task: LedgerTask, pre: ResumeSource | null, workflowRev: number) {
  if (!pre?.ok) return null;
  const s = pre.source;
  return { dedupKey: `${ADOPT_OP}:${task.id}:${s.reviewSeq}:w${workflowRev}`, event: { project: task.project, target: task.id, kind: "scheduler" as const,
    text: `交回自动时承接人工审查 #${s.reviewSeq}（PM 挂池单 ${s.orderId}，${s.reviewer} / ${s.family}）`, data: { op: ADOPT_OP, category: "manual", ...s, workflowRev } } };
}

/** The resume event's reviewSource mark: the adoption's seq, or why the current verdict was not adopted. */
export function adoptionMark(pre: ResumeSource | null, adoptedSeq: number | null): Record<string, unknown> {
  if (!pre) return {};
  if (!pre.ok) return { reviewSource: { refused: pre.why, reviewSeq: pre.reviewSeq } };
  return { reviewSource: { adopted: adoptedSeq, reviewSeq: pre.source.reviewSeq, kind: pre.source.kind, orderId: pre.source.orderId } };
}

export type AdoptionCheck = { ok: true; source: AdoptedSource & { agent: string } } | { ok: false; why: string };

/**
 * The one adoption predicate (planner snapshot and both merge gates): the current verdict is the source the current workflow rev was
 * resumed with, the adopting PM still holds the project's rights, and the whole source re-proves now (no newer review step / offer,
 * full pool proof). null = this card was never adopted; otherwise held or lapsed, with why.
 */
export function adoptionCheck(db: Database, task: LedgerTask, workflow: TaskWorkflow | null, deps: SourceDeps = {}): AdoptionCheck | null {
  // Cards that were never adopted (every ordinary auto card) stop here, before any further read.
  if (!db.query("SELECT 1 FROM events WHERE target = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = ? LIMIT 1").get(task.id, ADOPT_OP)) return null;
  const no = (why: string): AdoptionCheck => ({ ok: false, why: `人工审查承接不成立：${why}` });
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev) return no("流程不是本规格版本的自动模式");
  const events = listEvents(db, { project: task.project, target: task.id });
  const a = events.findLast((e) => e.kind === "scheduler" && e.data.op === ADOPT_OP)!;
  if (a.data.workflowRev !== workflow.rev) return no("流程版本已不是承接时那一版");
  // Only resumeCore writes this op (a scheduler event, never appendable), in the transaction that set this rev; the scheduler never adopts.
  if (a.actor === "scheduler" || !actorMayConfigure(db, a.actor, task.project)) return no(`承接人 ${a.actor} 现在没有本项目权限`);
  const f = currentFacts(db, task, events);
  if (!f || typeof f === "string") return no(f ?? "本轮没有审查结论");
  if (f.reviewer === a.actor) return no("交回人不能承接自己的审查");
  const s = sourceRefusal(db, task, workflow, f, events, a.seq, deps);
  if (typeof s === "string") return no(s);
  return sameSource(a.data, s) ? { ok: true, source: { ...s, agent: s.reviewer } } : no("当前结论不是承接的那一条");
}

/** Both merge gates: the adopted source when the check holds; else null (the old gates then refuse with their own reasons). */
export function adoptedReviewSource(db: Database, task: LedgerTask, workflow: TaskWorkflow | null, deps: SourceDeps = {}): (AdoptedSource & { agent: string }) | null {
  const c = adoptionCheck(db, task, workflow, deps);
  return c?.ok ? c.source : null;
}

/** The planner snapshot's copy of the same check (autoSnapshot fills it): held with its ref, or refused with why; null = never adopted. */
export type AdoptedFact = { ok: true; ref: AdoptedRef } | { ok: false; why: string };
export const adoptedFact = (c: AdoptionCheck | null): AdoptedFact | null => !c ? null : !c.ok ? c
  : { ok: true, ref: { reviewSeq: c.source.reviewSeq, reviewer: c.source.reviewer, sessionId: c.source.sessionId, family: c.source.family } };

/** Planner side (pure): the verdict is exactly the source the snapshot's full re-proof held; absent / refused = not adopted. */
export const adoptedReview = (s: Pick<PlannerSnapshot, "adoptedSource">, f: ReviewFacts): boolean => {
  const a = s.adoptedSource?.ok ? s.adoptedSource.ref : null;
  return !!a && a.reviewSeq === f.eventSeq && a.reviewer === f.reviewer && a.sessionId === f.reviewerSessionId && a.family === f.reviewerFamily;
};
