/**
 * dispatch-recovery-AUTOACK1 · a PM hand-back (`ledger workflow-resume`, PM identity only) may carry the card's current, complete manual
 * review into auto. One source only: the reviewer's own MCP ticket (a PM-assigned review step → take_review → submit_verdict, dedup
 * verdict:<orderId>@<head>, actor = reviewer, via mcp). Pool verdicts stay with the unchanged pool receipt gate (scheduler orders only).
 * A PM-recorded / CLI-copied report, a self or author review, a same-family verdict outside a current exemptVerdict, P0/P1, another
 * head / spec / round, or a live order / lease / newer review step: nothing adopted, the old gates refuse as before.
 * The adoption is its own scheduler event naming the original order and verdict (category manual); it never writes an intent, ack or
 * session bind. Valid only for the workflow rev the resume set; planner and both merge gates re-check it. tests/scheduler-manual-review-source*.test.ts.
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
import { manualOrderId } from "./order-take.js";
import { claimsPoolReview } from "./pool-review-proof.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { exemptFacts, exemptVerdict, openSafetyHold } from "./scheduler-review-swap.js";

export const ADOPT_OP = "manual_review_adopt";
/** What an adoption event records: the original verdict / order, never a new one. */
export interface AdoptedSource {
  kind: "manual_mcp"; reviewSeq: number; orderId: string; reviewer: string; sessionId: string; family: AuthorFamily;
  head: string; round: number; specRev: number; reportPath: string; assignSeq: number;
}

type Window = Pick<LedgerTask, "id" | "agent" | "headSHA" | "round" | "specRev" | "stage">;
const MODE_OPS: readonly string[] = ["workflow", "workflow_resume", "fallback_manual"];
const REVIEW_STEPS: readonly string[] = ["review", "final_review"];
const WRITE_STEPS: readonly string[] = ["write", "fix"];
const obj = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const modeEvent = (e: LedgerEvent): boolean => e.kind === "scheduler" && MODE_OPS.includes(String(e.data.op));
const manualMode = (e: LedgerEvent | undefined): boolean =>
  !!e && (e.data.op === "fallback_manual" || (e.data.op === "workflow" && e.data.mode === "manual"));
const sameAssign = (a: LedgerEvent, b: LedgerEvent): boolean =>
  b.kind === "step" && b.data.op === "assign" && b.data.step === a.data.step && b.data.round === a.data.round;

/**
 * The verdict event's own proof, pure (planner and writer share it): this round / spec's review window, written while the card was
 * manual (no mode change between it and `until`), a passing verdict, and the reviewer's own ticket. A string says why not.
 */
function sourceShape(events: readonly LedgerEvent[], task: Window, f: ReviewFacts, until = Infinity): Omit<AdoptedSource, "specRev"> | string {
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
  const base = { reviewSeq: ev.seq, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily, head: f.head, round: task.round, reportPath: f.reportPath };
  if (obj(ev.data.lend) || claimsPoolReview({ reviewer: f.reviewer, session: f.reviewerSessionId })) return "池单结论只走原池回执闸，不承接";
  const orderId = ev.data.orderId;
  if (ev.data.via !== "mcp" || ev.actor !== f.reviewer || typeof orderId !== "string" || ev.dedupKey !== `verdict:${orderId}@${String(ev.data.head)}`) {
    return "不是审查员本人经 take_review / submit_verdict 交的结论（PM 代记、CLI 复制没有本人票据），继续人工合并队列";
  }
  const assign = events.findLast((e) => e.seq < ev.seq && e.kind === "step" && e.data.op === "assign" && REVIEW_STEPS.includes(String(e.data.step)) &&
    manualOrderId(task.id, String(e.data.step), Number(e.data.round)) === orderId);
  if (!assign || assign.data.executor !== f.reviewer || assign.data.executorKind !== "agent") return "审查单不是 PM 正式派给这位审查员的审查步骤";
  if (events.some((e) => e.seq > ev.seq && sameAssign(assign, e))) return "这一审查步骤在结论之后又改派过";
  return { ...base, kind: "manual_mcp", orderId, assignSeq: assign.seq };
}

const sameSource = (d: Record<string, unknown>, s: Omit<AdoptedSource, "specRev">, task: Window): boolean =>
  d.reviewSeq === s.reviewSeq && d.kind === s.kind && d.orderId === s.orderId && d.reviewer === s.reviewer && d.sessionId === s.sessionId &&
  d.family === s.family && d.head === s.head && d.reportPath === s.reportPath && d.round === task.round && d.specRev === task.specRev && d.category === "manual";

/** The adoption the current workflow rev was resumed with, for this verdict; null = none or no longer this card's state. */
function adoptionOf(events: readonly LedgerEvent[], task: Window, workflow: Pick<TaskWorkflow, "mode" | "rev" | "specRev"> | null, f: ReviewFacts) {
  const a = events.findLast((e) => e.kind === "scheduler" && e.data.op === ADOPT_OP);
  if (!a || !workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || a.data.workflowRev !== workflow.rev) return null;
  // Only resumeCore writes this op (a scheduler event, never appendable), in the transaction that set this rev; the scheduler never adopts.
  const shape = a.actor !== "scheduler" ? sourceShape(events, task, f, a.seq) : "";
  return typeof shape !== "string" && sameSource(a.data, shape, task) ? { event: a, shape } : null;
}

/** Planner side (pure): the verdict is the current adopted manual source, with the planner's own family rule (the reviewer is a local agent). */
export function adoptedReview(s: Pick<PlannerSnapshot, "task" | "workflow" | "events" | "author" | "remoteAuthorFamily">, f: ReviewFacts): boolean {
  const a = adoptionOf(s.events, s.task, s.workflow, f);
  if (!a || f.reviewer === s.author?.agent) return false;
  return f.reviewerFamily !== (s.remoteAuthorFamily ?? s.workflow?.authorFamily) || exemptFacts(s.events, s.task, f);
}

export interface SourceDeps { reportOk?: (path: string) => boolean }
const reportFile = (path: string): boolean => {
  try { const st = statSync(path); return isAbsolute(path) && st.isFile() && st.size > 0; } catch { return false; } // missing = the material cannot be checked
};

/** Ledger side: the shape plus everything only the ledger can prove — assigner, author session, family / exemption, report. */
function sourceRefusal(db: Database, task: LedgerTask, workflow: TaskWorkflow, f: ReviewFacts, events: readonly LedgerEvent[], until: number, deps: SourceDeps) {
  const shape = sourceShape(events, task, f, until);
  if (typeof shape === "string") return shape;
  const hold = openSafetyHold(events);
  if (hold) return `安全留证 #${hold.seq} 未处置`;
  const author = db.query("SELECT agent FROM scheduler_sessions WHERE taskId = ? AND role = 'author' AND state != 'retired'").get(task.id) as { agent: string } | null;
  if (author?.agent === f.reviewer) return "审查人是本卡作者 session";
  const assign = events.find((e) => e.seq === shape.assignSeq);
  if (!assign || !actorMayConfigure(db, assign.actor, task.project)) return "审查步骤不是项目 PM / master / owner 派的";
  if (f.reviewerFamily === (remoteHeadFamily(db, task) ?? workflow.authorFamily) && !exemptVerdict(db, task, f)) return "审查与作者同家族且没有当前有效的豁免";
  if (!(deps.reportOk ?? reportFile)(f.reportPath)) return "原审查报告读不到，材料无法核";
  return { ...shape, specRev: task.specRev };
}

/** The current round's verdict (main carries as the merge gate reads them), or null when there is none to adopt. */
function currentFacts(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): ReviewFacts | string | null {
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  return read.kind === "facts" ? read.facts : read.kind === "none" ? null : read.reason;
}

/** Work or receipts still out on the card: an adoption would overwrite them. */
function liveRefusal(db: Database, task: LedgerTask, events: readonly LedgerEvent[], s: AdoptedSource): string | null {
  const open = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('submitted','unknown')").all(task.id) as { id: string }[];
  if (open.length) return `调度意图 ${open.map((o) => o.id).join("、")} 结果未定`;
  const lend = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()
    ? db.query("SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')").all(task.id) as { orderId: string }[] : [];
  if (lend.length) return `出借单 ${lend.map((o) => o.orderId).join("、")} 仍在途`;
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_write_leases'").get() && heldLease(db, task)) return "写租约仍被持有";
  const later = events.some((e) => e.seq > s.reviewSeq && e.kind === "step" && e.data.op === "assign" && REVIEW_STEPS.includes(String(e.data.step)));
  if (later) return "结论之后又派了新的审查步骤，可能有审查在跑";
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
  const live = liveRefusal(db, task, events, s);
  return live ? { ok: false, why: live, reviewSeq: f.eventSeq } : { ok: true, source: s };
}

/** The adoption event the resume writer inserts (it owns the transaction and the write), or null when nothing is adopted. */
export function adoptionEvent(task: LedgerTask, pre: ResumeSource | null, workflowRev: number) {
  if (!pre?.ok) return null;
  const s = pre.source;
  return { dedupKey: `${ADOPT_OP}:${task.id}:${s.reviewSeq}:w${workflowRev}`, event: { project: task.project, target: task.id, kind: "scheduler" as const,
    text: `交回自动时承接人工审查 #${s.reviewSeq}（本人票据 ${s.orderId}，${s.reviewer} / ${s.family}）`, data: { op: ADOPT_OP, category: "manual", ...s, workflowRev } } };
}

/** The resume event's reviewSource mark: the adoption's seq, or why the current verdict was not adopted. */
export function adoptionMark(pre: ResumeSource | null, adoptedSeq: number | null): Record<string, unknown> {
  if (!pre) return {};
  if (!pre.ok) return { reviewSource: { refused: pre.why, reviewSeq: pre.reviewSeq } };
  return { reviewSource: { adopted: adoptedSeq, reviewSeq: pre.source.reviewSeq, kind: pre.source.kind, orderId: pre.source.orderId } };
}

/** Both merge gates: the adopted reviewer when the current verdict is still the adopted, fully re-proved manual source; else null. */
export function adoptedReviewSource(db: Database, task: LedgerTask, workflow: TaskWorkflow, deps: SourceDeps = {}): (AdoptedSource & { agent: string }) | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const f = currentFacts(db, task, events);
  const a = f && typeof f !== "string" ? adoptionOf(events, task, workflow, f) : null;
  if (!a || typeof f === "string" || !f) return null;
  const s = sourceRefusal(db, task, workflow, f, events, a.event.seq, deps);
  return typeof s === "string" ? null : { ...s, agent: s.reviewer };
}
