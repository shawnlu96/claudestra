/** Narrow recovery writers: CLI transactions re-read authority and derive all event contents themselves. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type AuthorFamily, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { resumeAutoWorkflow, resumeCore } from "./ledger-scheduler-resume.js";
import { getEventByDedup, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { extensionMode, type ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { manualRecoveryMechanism, PROOF_OP, proofKey, proofReason, proveRecovery, type ExternalSnapshot, type RecoveryProof } from "./manual-recovery-release.js";
import { manualResumeReason, manualResumeVerdict } from "./manual-resume.js";
import { gateRecovery, recordObserved, recoveryPolicy, type RecoveryKey, type RecoveryPolicyPort } from "./recovery-policy.js";
import { convergeFollowUp, escalationFollowUp } from "./review-converge-followup.js";
import { roundCapText } from "./review-converge-notice.js";
import { convergeReview, ROUND_CAP_CODE } from "./review-converge.js";
import { fixDiffOf } from "./review-converge-scope.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { planScheduler } from "./scheduler-plan.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { cleanCreateReceipt, createFailStreak } from "./scheduler-create-retry.js";
import { classifyModelOutcome } from "./scheduler-model-outcome.js";
import { fallbackAction, fallbackEpochEvent, fallbackFacts, fallbackKey, type FallbackFacts, type FallbackInput } from "./scheduler-review-fallback.js";
import { openRefusal } from "./scheduler-review-swap.js";
import { getSchedulerSession, preserveSessionHistory } from "./scheduler-sessions.js";

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

export interface RecoveryObserveInput { taskId: string; mechanism: string; actionKey: string; action: string; data?: Record<string, unknown> }

/**
 * The scheduler's one generic observe record (`scheduler-recovery-observe`): a mechanism running on the service's query_only connection
 * hands its would-be action here. recordObserved owns the key check (unknown mechanism / bad actionKey = invalid), the text, the dedup
 * and the legacy key; the same action again reports recorded=false with the first seq.
 */
export function writeRecoveryObserve(db: Database, ctx: WriteCtx, input: RecoveryObserveInput, active: () => void) {
  return tx(db, () => {
    active();
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "恢复写口只给调度服务");
    const task = getTask(db, input.taskId);
    if (!task) throw new LedgerError("not_found", "任务不存在");
    return { ok: true, ...recordObserved(db, { project: task.project, mechanism: input.mechanism as RecoveryKey, target: task.id, actionKey: input.actionKey,
      action: input.action, ...(input.data ? { data: input.data } : {}) }, ctx.now ?? Date.now()) };
  });
}

export interface ManualRecoveryInput extends RecoveryFence {
  mechanism: string; mode: "on" | "observe"; maxWorkers: number;
  /** what the CLI proved before the transaction, with the snapshot it read */
  fingerprint: string; external: ExternalSnapshot | null;
}

/** Inside the transaction: the switch still says this mode and the same snapshot proves the same fingerprint. */
function reprove(db: Database, task: LedgerTask, workflow: TaskWorkflow, input: ManualRecoveryInput, policy?: ExplicitPolicyPort): RecoveryProof {
  const m = manualRecoveryMechanism(input.mechanism);
  if (!m) throw new LedgerError("not_found", `没有登记的恢复机制 ${input.mechanism}`);
  const mode = extensionMode(task.project, m.key, policy);
  if (mode.mode !== input.mode) throw new LedgerError("forbidden", `恢复机制 ${m.id} 的策略与写入时不一致（现在 ${mode.mode}：${mode.why}）`);
  const v = proveRecovery(db, task, workflow, m.id, input.external);
  if (v.kind === "refused") throw new LedgerError("conflict", `manual 扩展恢复条件不再成立：${v.why}`);
  if (v.proof.fingerprint !== input.fingerprint) throw new LedgerError("conflict", "manual 扩展恢复证明已失效（读证据和交回之间卡变过），下一轮重读");
  return v.proof;
}

/** Fixed-length, so every registrable id (≤120) fits recordObserved's 120-character actionKey; the full id stays in the note's proof. */
const mechanismDigest = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 16);

const DRY_RUN = Symbol("dry-run");
const refuseLoop = (next: Record<string, unknown>) => {
  if (next.kind === "escalate") throw new LedgerError("conflict", `交回后规划器只会再 escalate（${String(next.code)}），不制造 auto/manual 循环`);
};

/**
 * The hand-back and its seal, then the loop check: resumeCore records the workflow_resume, the proof is sealed right after it, and
 * only then is the planner asked what comes next, so mergeRetryReleased sees this very proof (a bound cancellation is released) and
 * an escalate still refuses. resumeCore's own `next` on the event was planned before the seal; the seal records the one that counts.
 */
function handBack(db: Database, at: WriteCtx & { now: number }, task: LedgerTask, workflow: TaskWorkflow, proof: RecoveryProof, maxWorkers: number) {
  const reason = proofReason(proof);
  const r = resumeCore(db, at, { taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev, reason, maxWorkers }, { auto: true, recoveryProof: proof });
  const resumed = listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "scheduler" && e.data.op === "workflow_resume")!;
  const sealWith = (next?: Record<string, unknown>) => insertEvent(db, { ...at, dedupKey: proofKey(proof) }, { project: task.project, target: task.id, kind: "scheduler",
    text: `恢复证明封存：${reason}`, data: { op: PROOF_OP, resumeSeq: resumed.seq, fingerprint: proof.fingerprint, mechanism: proof.mechanism, episodeId: proof.episodeId, next } }, true);
  // the planner must see the seal, and the seal must carry the planner's decision: plan against a rolled-back seal, then write the real one
  let next: Record<string, unknown> = {};
  try {
    db.transaction(() => {
      sealWith();
      const d = planScheduler(autoSnapshot(db, getTask(db, task.id)!, { registry: [], maxWorkers, now: at.now }));
      next = d.kind === "intent" ? { kind: d.kind, node: d.node, action: d.action } : { kind: d.kind, code: d.code, reason: d.reason };
      throw DRY_RUN;
    })();
  } catch (e) { if (e !== DRY_RUN) throw e; }
  refuseLoop(next);
  const seal = sealWith(next);
  return { ...r, next, sealSeq: seal.seq };
}

/**
 * Evidence mechanisms' only writer. observe runs the hand-back in a rolled-back savepoint (nothing changes) and records would-resume
 * once; on hands back through resumeCore and seals the proof right after it (same transaction, one per episode). Either refuses when
 * the planner, with the sealed proof in view, would only escalate again.
 */
export function writeManualRecovery(db: Database, ctx: WriteCtx, input: ManualRecoveryInput, active: () => void, policy?: ExplicitPolicyPort) {
  return tx(db, () => {
    const { task, workflow } = fencedTask(db, ctx, input, active);
    const proof = reprove(db, task, workflow, input, policy);
    if (getEventByDedup(db, proofKey(proof))) throw new LedgerError("conflict", `证明 ${proof.mechanism}:${proof.episodeId} 已交回过一次`);
    active();
    const at = { ...ctx, now: ctx.now ?? Date.now() }, reason = proofReason(proof);
    if (input.mode === "observe") {
      let next: Record<string, unknown> = {};
      try { db.transaction(() => { next = handBack(db, at, task, workflow, proof, input.maxWorkers).next; throw DRY_RUN; })(); } catch (e) { if (e !== DRY_RUN) throw e; }
      return { ok: true, reason, ...recordObserved(db, { project: task.project, mechanism: manualRecoveryMechanism(proof.mechanism)!.key, target: task.id,
        actionKey: `recover.${mechanismDigest(proof.mechanism)}.${proof.fingerprint}`, action: `把 ${task.id} 交回自动：${reason}`, data: { recoveryProof: proof, next } }, at.now) };
    }
    return { ok: true, reason, ...handBack(db, at, task, workflow, proof, input.maxWorkers), proof };
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

type Placement = { family: AuthorFamily; machine: string };
/** A failed review order as the service saw it: a review turn (its session), or a reviewer ensure_session (the receipt is re-read). */
export interface ReviewFallbackInput {
  intentId: string;
  failure: { kind: "error" | "quota" | "auth"; message: string };
  failed: Placement & { agent: string };
  authorized: readonly Placement[];
  sessionId?: string;
}
export type ReviewFallbackResult = { outcome: "acted"; event: LedgerEvent; duplicate: boolean } | { outcome: "observed"; recorded: boolean; action: string }
  | { outcome: "skipped"; reason: string };

/** Every fallback fact read now from the ledger (the create's receipt and streak, the binding, holds); a string says why not. */
function fallbackRead(db: Database, input: ReviewFallbackInput): { facts: FallbackFacts; fi: FallbackInput } | string {
  const intent = getIntent(db, input.intentId);
  if (!intent) return "缺原调度意图";
  const create = intent.action === "ensure_session", message = create ? intent.receipt ?? "" : input.failure.message;
  const c = classifyModelOutcome({ failure: create ? { kind: "error", message } : input.failure });
  const fi: FallbackInput = { intent, failed: input.failed, authorized: input.authorized, message, cls: c?.cls ?? null, recoverable: c?.recoverable ?? false,
    row: getSchedulerSession(db, intent.taskId, "reviewer"), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(create ? { cleanCreate: cleanCreateReceipt(intent.receipt), createStreak: createFailStreak(db, intent.taskId, "reviewer") } : {}) };
  const facts = fallbackFacts(db, fi);
  if (typeof facts === "string") return facts;
  const hold = openRefusal(listEvents(db, { project: facts.task.project, target: facts.task.id }));
  return hold ? `本卡有未处置的模型安全拒绝或拒审接续（#${hold.seq}）` : { facts, fi };
}

/** One transaction: re-read every fact, write the epoch (dedup per failed order) and retire the failed binding if there was one. */
function applyFallback(db: Database, ctx: WriteCtx, input: ReviewFallbackInput): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const done = getEventByDedup(db, fallbackKey(input.intentId));
    if (done) return { event: done, duplicate: true };
    const read = fallbackRead(db, input);
    if (typeof read === "string") throw new LedgerError("conflict", `不降级：${read}`);
    const { facts, fi } = read, e = fallbackEpochEvent(facts, fi), now = ctx.now ?? Date.now();
    preserveSessionHistory(db);
    const event = insertEvent(db, { ...ctx, now, dedupKey: fallbackKey(fi.intent.id) }, { project: facts.task.project, target: facts.task.id, kind: "scheduler", ...e }, true);
    const retired = facts.row?.state === "active" ? facts.row.sessionId : null; // the failed binding; a create failure had none
    if (retired) db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE sessionId = ?").run(fi.intent.id, now, retired);
    return { event, duplicate: false };
  });
}

/**
 * RVF-1 · the reviewer fallback's only writer, under recovery key reviewFallback: off = nothing, observe = one note of where the
 * review would go (the card escalates / backs off as before), on = the epoch. Reached through `ledger scheduler-model-outcome`
 * (scheduler-model-wiring.ts), for a failed review turn and for a reviewer create that failed and cleaned up.
 */
export async function writeReviewFallback(db: Database, ctx: WriteCtx, input: ReviewFallbackInput, policy?: RecoveryPolicyPort): Promise<ReviewFallbackResult> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "审查降级只由调度服务记录");
  const done = getEventByDedup(db, fallbackKey(input.intentId));
  if (done) return { outcome: "acted", event: done, duplicate: true };
  const read = fallbackRead(db, input);
  if (typeof read === "string") return { outcome: "skipped", reason: read };
  const { facts, fi } = read, action = fallbackAction(facts, fi);
  const g = await gateRecovery(db, { project: facts.task.project, mechanism: "reviewFallback", target: facts.task.id, actionKey: `fallback:${fi.intent.id}`, action,
    data: { reviewFallback: { intentId: fi.intent.id, trigger: facts.trigger, from: input.failed, to: facts.to, reason: fi.message.slice(0, 600) } } },
    () => applyFallback(db, ctx, input), { now: ctx.now ?? Date.now(), ...(policy ? { policy } : {}) });
  if (g.outcome === "skipped") return { outcome: "skipped", reason: g.reason };
  return g.outcome === "observed" ? { outcome: "observed", recorded: g.recorded, action } : { outcome: "acted", ...g.value };
}
