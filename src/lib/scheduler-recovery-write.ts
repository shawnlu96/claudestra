/** Narrow recovery writers: CLI transactions re-read authority and derive all event contents themselves. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { resumeAutoWorkflow } from "./ledger-scheduler-resume.js";
import { getEventByDedup, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { manualResumeReason, manualResumeVerdict } from "./manual-resume.js";
import { recordObserved, recoveryPolicy } from "./recovery-policy.js";
import { convergeFollowUp, escalationFollowUp } from "./review-converge-followup.js";
import { roundCapText } from "./review-converge-notice.js";
import { convergeReview, ROUND_CAP_CODE } from "./review-converge.js";
import { fixDiffOf } from "./review-converge-scope.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { planScheduler } from "./scheduler-plan.js";
import { currentReviewFacts } from "./scheduler-review.js";

export interface RecoveryFence { taskId: string; taskRev: number; workflowRev: number; head: string | null; round: number; specRev: number }
export interface ReviewRecoveryInput extends RecoveryFence { reviewSeq: number }

function fencedTask(db: Database, ctx: WriteCtx, f: RecoveryFence, active: () => void) {
  active();
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "恢复写口只给调度服务");
  const task = getTask(db, f.taskId), workflow = getWorkflow(db, f.taskId);
  if (!task || !workflow) throw new LedgerError("not_found", "任务或流程不存在");
  if (task.rev !== f.taskRev || workflow.rev !== f.workflowRev || task.headSHA !== f.head || task.round !== f.round || task.specRev !== f.specRev) {
    throw new LedgerError("conflict", "任务 / 流程 / head / round / specRev 已变，拒绝恢复写入");
  }
  return { task, workflow };
}

export function writeManualResume(db: Database, ctx: WriteCtx, input: RecoveryFence & { mode: "on" | "observe"; reason: string; maxWorkers: number }, active: () => void) {
  return tx(db, () => {
    const { task, workflow } = fencedTask(db, ctx, input, active);
    const current = recoveryPolicy(task.project, "manualStall");
    if (current.mode !== input.mode || !["on", "observe"].includes(current.mode)) throw new LedgerError("forbidden", "manualStall mode 与写入时策略不一致");
    const verdict = manualResumeVerdict(db, task, workflow);
    if (!verdict.ok) throw new LedgerError("conflict", `manual 自动恢复条件不再成立：${verdict.why}`);
    const reason = manualResumeReason(verdict.facts);
    if (reason !== input.reason) throw new LedgerError("conflict", "manual 自动恢复 fingerprint / 原因已变");
    active();
    if (input.mode === "observe") return { ok: true, ...recordObserved(db, { project: task.project, mechanism: "manualStall", target: task.id,
      actionKey: `resume.${verdict.facts.fingerprint}`, action: `把 ${task.id} 交回自动：${reason}`, data: { manualResume: verdict.facts } }, ctx.now ?? Date.now()) };
    return { ok: true, ...resumeAutoWorkflow(db, ctx, { taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev, reason, maxWorkers: input.maxWorkers }) };
  });
}

function reviewState(db: Database, ctx: WriteCtx, input: ReviewRecoveryInput, active: () => void) {
  const { task, workflow } = fencedTask(db, ctx, input, active), events = listEvents(db, { project: task.project, target: task.id });
  if (task.stage !== "review" || workflow.mode !== "auto" || workflow.specRev !== task.specRev) throw new LedgerError("conflict", "不在当前自动审查阶段");
  const review = currentReviewFacts(task, events);
  if (review.kind !== "facts" || review.facts.eventSeq !== input.reviewSeq) throw new LedgerError("conflict", "正式审查来源已变");
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: 2, now: ctx.now ?? Date.now() }));
  return { task, events, review: review.facts, plan };
}

export function writeReviewHold(db: Database, ctx: WriteCtx, input: ReviewRecoveryInput & { action: "prepare" | "informed" }, active: () => void) {
  return tx(db, () => {
    const { task, events, review, plan } = reviewState(db, ctx, input, active);
    if (plan.kind !== "wait" || plan.code !== ROUND_CAP_CODE) throw new LedgerError("conflict", "当前正式审查不再触发轮次上限");
    active();
    if (input.action === "prepare") {
      const { downgrade } = convergeReview(events, review, fixDiffOf(task, events));
      if (downgrade) convergeFollowUp(db, ctx, task, downgrade);
      return { ok: true };
    }
    const key = `scheduler:review-cap:${task.id}:${review.eventSeq}`, done = getEventByDedup(db, key);
    if (done) return { ok: true, duplicate: true, event: done };
    const event = insertEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: roundCapText(task, events), data: { op: "review_round_hold", round: task.round, reviewSeq: review.eventSeq, informed: true } }, true);
    return { ok: true, duplicate: false, event };
  });
}

export function writeReviewDowngrade(db: Database, ctx: WriteCtx, input: ReviewRecoveryInput, active: () => void) {
  return tx(db, () => {
    const { task, plan } = reviewState(db, ctx, input, active);
    if (plan.kind !== "escalate" || !["review_block", "three_p1_rounds"].includes(plan.code) || plan.reviewSeq !== input.reviewSeq) {
      throw new LedgerError("conflict", "当前正式审查不再授权退人工降级");
    }
    active();
    escalationFollowUp(db, task, plan);
    return { ok: true };
  });
}
