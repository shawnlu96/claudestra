/** Reviewer epochs: an author-family takeover invalidates the old binding, not its audit history. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { createRefusalApprovalPort } from "./recovery-refusal-approval.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { ReviewFacts } from "./scheduler-review.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import type { reviewPlacement } from "./scheduler-placement-plan.js";
import type { SchedulerSession } from "./scheduler-sessions.js";

export const latestReviewerSwap = (events: readonly LedgerEvent[]): LedgerEvent | undefined =>
  events.findLast((e) => e.kind === "scheduler" && e.data.op === "reviewer_swap");

/** CONV2 can start a new epoch with the same event; ordinary cards retain their original continuity rule. */
export function reviewsAfterSwap(events: readonly LedgerEvent[]): LedgerEvent[] {
  const after = latestReviewerSwap(events)?.seq ?? 0;
  return events.filter((e) => e.kind === "review" && e.seq > after);
}

function independentReviewer(s: PlannerSnapshot): boolean {
  const r = s.reviewer;
  return !!r && r.taskId === s.task.id && !!r.agent && !!r.sessionId && r.family !== s.workflow?.authorFamily &&
    r.agent !== s.author?.agent && r.agent !== s.task.agent && (s.workflow?.template !== "security" || r.source === "local");
}

type SwapSnapshot = Pick<PlannerSnapshot, "task" | "workflow" | "events" | "reviewer" | "remoteAuthorFamily"> & {
  author: { agent: string; family: string } | null;
};

/** Only acknowledged, unbound manual history may precede an automatic bind without establishing session continuity. */
export function reviewerHistory(s: Pick<PlannerSnapshot, "events" | "reviewer">): LedgerEvent[] {
  const r = s.reviewer;
  const bind = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === "session_bind" && e.data.role === "reviewer" &&
    e.data.agent === r?.agent && e.data.sessionId === r?.sessionId && e.data.family === r?.family);
  return reviewsAfterSwap(s.events).filter((e) => {
    if (String(e.data.reviewer ?? "").startsWith("peer:")) return false;
    if (!bind || e.seq > bind.seq) return true;
    if (bind.data.manual === true) return false;
    const workflow = s.events.findLast((w) => w.seq < e.seq && w.kind === "scheduler" && ["workflow", "workflow_resume"].includes(String(w.data.op)));
    const acknowledged = s.events.some((w) => w.seq > e.seq && w.seq < bind.seq && w.kind === "scheduler" &&
      w.data.op === "workflow_resume" && w.data.manual === true);
    const bound = s.events.some((w) => w.seq < e.seq && w.kind === "scheduler" && w.data.op === "session_bind" && w.data.role === "reviewer");
    return workflow?.data.mode !== "manual" || !acknowledged || bound;
  });
}

const remoteDelivery = (events: readonly LedgerEvent[]): boolean =>
  !!events.findLast((e) => e.kind === "deliver" && typeof e.data.headSHA === "string")?.dedupKey?.match(/^lend-(deliver|takeover-deliver):/);

function newAuthorDelivery(s: SwapSnapshot): boolean {
  const deliveries = s.events.filter((e) => e.kind === "deliver" && typeof e.data.headSHA === "string");
  const delivered = deliveries.at(-1), previous = deliveries.at(-2);
  if (!delivered || !previous || delivered.data.headSHA !== s.task.headSHA || previous.data.headSHA === s.task.headSHA ||
    !/^[a-f0-9]{40}$/i.test(s.task.headSHA ?? "")) return false;
  const reviewStage = s.events.findLast((e) => e.kind === "stage" && e.data.to === "review");
  if (!reviewStage || reviewStage.data.round !== s.task.round || reviewStage.data.specRev !== s.task.specRev || previous.seq >= reviewStage.seq) return false;
  if (remoteDelivery(s.events)) return !!s.remoteAuthorFamily && s.remoteAuthorFamily === s.workflow?.authorFamily;
  return delivered.actor === s.author?.agent && s.author.family === s.workflow?.authorFamily && delivered.data.round === s.task.round;
}

function swapNeeded(s: SwapSnapshot): boolean {
  const r = s.reviewer;
  if (!r || r.source !== "local" || r.taskId !== s.task.id || !r.agent || !r.sessionId || s.task.round < 2) return false;
  if (exemptSession(s.events, s.task, r.sessionId, r.family)) return false; // the exemption's own reviewer is not a family takeover
  const prior = reviewerHistory(s)[0];
  // A different, unapproved session is still reviewer_replaced, not permission to start another epoch.
  if (prior && (prior.data.reviewer !== r.agent || prior.data.reviewerSessionId !== r.sessionId)) return false;
  return newAuthorDelivery(s) && (r.family === s.workflow?.authorFamily || r.agent === s.author?.agent || r.agent === s.task.agent);
}

/** Keep invalid legacy bindings on sessionGate's existing error path; only a swap may release a bound reviewer to the pool. */
export const keepsReviewer = (s: PlannerSnapshot): boolean => !!s.reviewer && (independentReviewer(s) || !swapNeeded(s));

/** Runs before placement and again at sessionGate: retiring the old session must precede any peer/local dispatch. */
export function reviewSwapPlan(s: PlannerSnapshot, node: string, place: typeof reviewPlacement): PlannerDecision | null {
  const swap = latestReviewerSwap(s.events);
  const missingFamily = remoteDelivery(s.events) && !s.remoteAuthorFamily;
  if (missingFamily || swapNeeded(s)) {
    // A model safety refusal outranks the family switch: swapping in would fetch the refused content from another model.
    const hold = openRefusal(s.events);
    if (hold) return { kind: "escalate", code: "model_safety_hold", reason: `本卡有未处置的模型安全拒绝（#${hold.seq}），不自动换家族审查，等 PM / owner 处置或批准的接续审查完成` };
    if (missingFamily) return { kind: "wait", code: "author_family_evidence", reason: "远端交付缺已完成写单的家族证据，等待对账后重算" };
    if (swap?.data.round === s.task.round) return { kind: "escalate", code: "reviewer_independence", reason: "本轮已换过审查员，新会话仍与当前作者不独立" };
    const born = s.events.find((e) => e.kind === "task")?.seq ?? 0;
    return { kind: "intent", id: `review-swap:s${born}:r${s.task.round}`, node, action: "review_swap", recipient: null,
      resources: [`task:s${born}`], observedOnly: s.workflow?.mode === "observe",
      reason: `作者家族由 ${s.reviewer!.family === "claude" ? "codex" : "claude"} 变成 ${s.workflow!.authorFamily}，更换不独立的审查会话` };
  }
  if (!swap || s.reviewer) return null;
  if (swap.data.refusal || swap.data.legacy === true) return null; // a refusal epoch's / legacy retirement's reviewer is created locally by sessionGate, never pooled
  const intent = s.intents.find((i) => i.id === swap.data.intentId);
  if (intent?.status !== "done") return { kind: "wait", code: "reviewer_swap", reason: "旧审查会话正在归档、停止，完成后再派跨家族审查" };
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === s.task.stage)?.seq ?? 0;
  const placement = place(s, since);
  if (placement && "peer" in placement) return null;
  if (placement) return { kind: "wait", code: "reviewer_capacity", reason: placement.wait };
  if (s.pool?.remote.agents) return null;
  return (s.pool?.localReviewers ?? 0) >= s.maxWorkers
    ? { kind: "wait", code: "reviewer_capacity", reason: "另一家族的 peer 无可用审查槽，本机审查名额也已满，等待空位后自动续派" } : null;
}

export const HOLD_OP = "model_safety_hold", RESOLVE_OP = "model_safety_resolved";
export const RETRY_OP = "model_refusal_retry", EXEMPT_OP = "model_refusal_exempt";

/** Only the writer's exact old-ticket replacement closes a pending plan; safety holds remain separately resolved. */
export function legacyReplacesPlan(events: readonly LedgerEvent[], plan: LedgerEvent): boolean {
  return (plan.data.op === RETRY_OP || plan.data.op === EXEMPT_OP) && events.some((e) => e.seq > plan.seq &&
    e.project === plan.project && e.target === plan.target &&
    e.kind === "scheduler" && e.data.op === "reviewer_swap" && e.data.legacy === true && !e.data.refusal &&
    e.data.replacedPlanSeq === plan.seq && e.data.intentId === plan.data.intentId && e.data.sessionId === plan.data.session &&
    e.data.sentHead === plan.data.head && e.data.sentSpecRev === plan.data.specRev && e.data.round === plan.data.round);
}

/**
 * A hold, or an approved refusal continuation still waiting for its review: either way no automatic family switch. A continuation
 * the refusal epoch already executed is closed — the epoch's own ensure / bind / review run under it.
 */
export function openRefusal(events: readonly LedgerEvent[]): LedgerEvent | null {
  const hold = openSafetyHold(events);
  if (hold) return hold;
  const cont = events.findLast((e) => e.data.op === RETRY_OP || e.data.op === EXEMPT_OP);
  return cont && !legacyReplacesPlan(events, cont) &&
    !events.some((e) => e.seq > cont.seq && (e.kind === "review" || refusalOf(e)?.planSeq === cont.seq)) ? cont : null;
}

/** The task's unresolved model safety hold (scheduler-model-outcome.ts writes it), or null. Only a manager's resolve lifts it. */
export function openSafetyHold(events: readonly LedgerEvent[]): LedgerEvent | null {
  const hold = events.findLast((e) => e.data.op === HOLD_OP);
  if (!hold) return null;
  return events.some((e) => e.seq > hold.seq && e.data.op === RESOLVE_OP && e.data.holdSeq === hold.seq) ? null : hold;
}

/** Also the dedup key of MODELXW's legacy retirement (scheduler-model-wiring.ts writeLegacyReviewRetire), keyed by the old ticket. */
export const swapKey = (id: string): string => `scheduler:${id}:reviewer-swap`;

function swapIntent(db: Database, ctx: WriteCtx, id: string): SchedulerIntent {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "更换审查员只由调度服务执行");
  const intent = getIntent(db, id);
  if (!intent || intent.action !== "review_swap" || intent.node !== "adversarial_review") throw new LedgerError("invalid", "缺换审查员意图");
  return intent;
}

/** Event + inactive binding + claim share one transaction. No session-retire shortcut, no deleted session rows. */
type SwapEvent = (ctx: WriteCtx, event: { project: string; target: string; kind: "scheduler"; text: string; data: Record<string, unknown> }) => void;

export function applyReviewerSwap(db: Database, ctx: WriteCtx, id: string, row: SchedulerSession | null, migrate: () => void, write: SwapEvent): SchedulerSession {
  const intent = swapIntent(db, ctx, id), task = mustTask(db, intent.taskId);
  const done = getEventByDedup(db, swapKey(id));
  if (done) return swappedSession(db, id);
  const workflow = getWorkflow(db, task.id);
  if (intent.status !== "pending" || task.stage !== "review" || task.rev !== intent.taskRev || task.specRev !== intent.specRev ||
    task.headSHA !== intent.head || workflow?.mode !== "auto" || workflow.specRev !== task.specRev) {
    throw new LedgerError("conflict", "换人计划已过期，先重算");
  }
  const events = listEvents(db, { project: task.project, target: task.id });
  const remoteFamily = remoteHeadFamily(db, task), family = remoteFamily ?? workflow.authorFamily;
  const delivery = events.findLast((e) => e.kind === "deliver" && typeof e.data.headSHA === "string");
  if (remoteDelivery(events) && !remoteFamily) {
    throw new LedgerError("conflict", "远端交付缺已完成写单的家族证据");
  }
  const author = db.query("SELECT agent, family FROM scheduler_sessions WHERE taskId = ? AND role = 'author' AND state != 'retired'")
    .get(task.id) as { agent: string; family: string } | null;
  const s: SwapSnapshot = { task, workflow: { ...workflow, authorFamily: family }, remoteAuthorFamily: remoteFamily, events, author,
    reviewer: row?.state === "active" ? { ...row, source: row.transport === "peer" ? "peer_claim" : "local" } : null };
  if (!row || !swapNeeded(s) || latestReviewerSwap(events)?.data.round === task.round) throw new LedgerError("conflict", "本轮不允许再次更换审查员");
  if (openRefusal(events)) throw new LedgerError("conflict", "本卡有未处置的模型安全拒绝，不自动更换审查员");
  migrate();
  settleIntent(db, ctx, { id, from: "pending", to: "submitted", receipt: "claimed; 更换不独立的审查员" });
  const fromFamily = row.family === "claude" ? "codex" : "claude";
  write({ ...ctx, dedupKey: swapKey(id) }, { project: task.project, target: task.id, kind: "scheduler",
    text: `作者家族由 ${fromFamily} 变成 ${family}，旧审查会话不再独立`,
    data: { op: "reviewer_swap", intentId: id, fromFamily, toFamily: family, agent: row.agent, sessionId: row.sessionId,
      round: task.round, head: task.headSHA, specRev: task.specRev, deliverySeq: delivery!.seq } });
  db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE sessionId = ?")
    .run(id, ctx.now ?? Date.now(), row.sessionId);
  return swappedSession(db, id);
}

export function swappedSession(db: Database, intentId: string): SchedulerSession {
  const row = db.query("SELECT * FROM scheduler_sessions WHERE retireIntentId = ? AND role = 'reviewer'").get(intentId) as SchedulerSession | null;
  if (!row) throw new LedgerError("not_found", "换人意图没有旧审查绑定");
  return row;
}

/** archiveReceipt also holds an explicit reuse marker, so author preservation needs no schema migration or fake kill receipt. */
export function applyReviewerSwapEffect(db: Database, ctx: WriteCtx, id: string, effect: "archive" | "kill" | "reuse", receipt: string, write: SwapEvent): void {
  const intent = swapIntent(db, ctx, id), row = swappedSession(db, id);
  const col = effect === "kill" ? "killReceipt" : "archiveReceipt";
  const reused = `reused_by_author:${row.agent}`;
  if (effect === "reuse" && (mustTask(db, intent.taskId).agent !== row.agent || receipt !== reused)) {
    throw new LedgerError("conflict", "沿用回执必须匹配本卡当前作者");
  }
  if (row[col]) {
    if (row[col] !== receipt) throw new LedgerError("dedup_mismatch", "换人效果已有不同回执");
    return;
  }
  if (intent.status !== "submitted" || (effect === "kill" && (!row.archiveReceipt || row.archiveReceipt === reused))) {
    throw new LedgerError("conflict", "换人必须先归档再停止");
  }
  if (!receipt.trim() || receipt.length > 600) throw new LedgerError("invalid", "换人回执为空或太长");
  db.query(`UPDATE scheduler_sessions SET ${col} = ?, updatedAt = ? WHERE sessionId = ?`).run(receipt, ctx.now ?? Date.now(), row.sessionId);
  write({ ...ctx, dedupKey: `${swapKey(id)}:${effect}` }, { project: intent.project, target: intent.taskId, kind: "scheduler",
    text: effect === "reuse" ? "旧审查会话由本卡作者沿用，未停用" : `旧审查会话 ${effect} 已确认`,
    data: { op: "reviewer_swap_effect", intentId: id, effect, receipt, sessionId: row.sessionId } });
}

/** Only a completed, explicitly recorded swap permits a new binding for the same role. */
export function mayRebindReviewer(db: Database, prior: SchedulerSession, intentId: string): boolean {
  if (prior.role !== "reviewer" || prior.state !== "retired" || !prior.retireIntentId) return false;
  const reused = prior.archiveReceipt === `reused_by_author:${prior.agent}`;
  const swap = getEventByDedup(db, swapKey(prior.retireIntentId));
  if (swap?.data.legacy === true) {
    const intent = getIntent(db, intentId), task = intent && mustTask(db, intent.taskId);
    const lapse = task && legacyReviewLapse(db, task, listEvents(db, { project: task.project, target: task.id }));
    if (lapse) throw new LedgerError("conflict", `不绑定旧单替代审查员：${lapse}`);
  }
  // MODELXW: a legacy refused ticket's reviewer is retired without being woken or killed (as under a refusal epoch)
  if (!prior.killReceipt && !reused && swap?.data.legacy !== true) return false;
  const intent = getIntent(db, intentId);
  return !!swap && swap.data.sessionId === prior.sessionId && !!intent && intent.eventSeq > swap.seq &&
    getIntent(db, prior.retireIntentId)?.status === "done";
}

/** The receipt proves past ownership; reassignment must not invalidate it or silently lose the unfinished retirement. */
export function reviewerReuseNote(task: LedgerTask, prior: SchedulerSession | null) {
  if (!prior || prior.archiveReceipt !== `reused_by_author:${prior.agent}` || prior.killReceipt || prior.agent === task.agent) return null;
  return { project: task.project, target: task.id, kind: "note" as const,
    text: `旧审查会话 ${prior.agent} 曾由作者沿用，作者已改派，该会话未停用，交退役流程收尾`,
    data: { op: "reviewer_reuse_reassigned", agent: prior.agent, sessionId: prior.sessionId, retireIntentId: prior.retireIntentId } };
}

/**
 * dispatch-recovery-MODELX, owner 10-06 14:45 (A): a provider policy refusal of the review (cyber_policy included) goes straight to
 * the other family under a recorded exemption — no same-model retry. The epoch is FAM1a's reviewer_swap event with a refusal field:
 * the refused binding is retired (its row and events stay; retireIntentId = the refused review ticket, which the epoch names as its
 * intentId), the next ensure_session binds the other family once, and a refusal
 * of that exempt review is MODEL's manual hold. Materials and prompts are untouched; the new reviewer judges by its own policy.
 */
const EXEMPT_MARK = "跨模型审查豁免:原审查模型策略拒审"; // = EXEMPTION_TEXT (scheduler-model-outcome.ts imports this module)
const refusalEpochId = (planSeq: number): string => `refusal-epoch:${planSeq}`;
const otherFamily = (f: AuthorFamily): AuthorFamily => f === "claude" ? "codex" : "claude";

interface RefusalMark { planSeq: number; approvalId: string; exemption: string; crossModel: boolean; materialDigest?: string }
const refusalOf = (e: LedgerEvent | undefined): RefusalMark | null =>
  e?.kind === "scheduler" && e.data.op === "reviewer_swap" && e.data.refusal && typeof e.data.refusal === "object" ? e.data.refusal as RefusalMark : null;

type Window = Pick<LedgerTask, "headSHA" | "specRev" | "round">;
const inWindow = (e: LedgerEvent, t: Window): boolean => e.data.head === t.headSHA && e.data.specRev === t.specRev && e.data.round === t.round;

/** The refusal epoch ruling this head / spec / round: the latest reviewer_swap, if it carries a refusal; else null. */
export function refusalEpoch(events: readonly LedgerEvent[], task: Window): LedgerEvent | null {
  const swap = latestReviewerSwap(events);
  return swap && refusalOf(swap) && inWindow(swap, task) ? swap : null;
}

/** The epoch's exemption as written: the fixed text with its approval id, never counted cross-model. */
function exemption(epoch: LedgerEvent): { approvalId: string; family: AuthorFamily } | null {
  const r = refusalOf(epoch);
  if (!r || typeof r.approvalId !== "string" || !r.approvalId || r.crossModel !== false || r.exemption !== `${EXEMPT_MARK}(批准 ${r.approvalId})`) return null;
  return { approvalId: r.approvalId, family: epoch.data.toFamily as AuthorFamily };
}

/** The session bound under this round's exemption epoch (bind event after it, marked with it and its approval id). */
function exemptBind(events: readonly LedgerEvent[], task: Window, sessionId: string, family: AuthorFamily): { epoch: LedgerEvent; approvalId: string } | null {
  const epoch = refusalEpoch(events, task), mark = epoch && exemption(epoch);
  if (!epoch || !mark || mark.family !== family) return null;
  const bound = events.some((e) => e.seq > epoch.seq && e.kind === "scheduler" && e.data.op === "session_bind" && e.data.role === "reviewer" &&
    e.data.sessionId === sessionId && e.data.family === family && e.data.refusalEpoch === epoch.seq && e.data.approvalId === mark.approvalId);
  return bound ? { epoch, approvalId: mark.approvalId } : null;
}

/** Planner side (pure): this reviewer session is the one the current round's exemption bound. */
export const exemptSession = (events: readonly LedgerEvent[], task: Window, sessionId: string, family: AuthorFamily): boolean =>
  !!exemptBind(events, task, sessionId, family);

type VerdictFacts = Pick<ReviewFacts, "eventSeq" | "round" | "head" | "reviewerSessionId" | "reviewerFamily">;

/** Planner side (pure): a verdict of the exemption's session, written after the epoch, for the epoch's own head and round. */
export function exemptFacts(events: readonly LedgerEvent[], task: Window, f: VerdictFacts): boolean {
  const b = exemptBind(events, task, f.reviewerSessionId, f.reviewerFamily);
  return !!b && f.eventSeq > b.epoch.seq && f.round === b.epoch.data.round && f.head === b.epoch.data.head;
}

/**
 * Both merge gates: an author-family verdict passes only under the round's exemption epoch (same head / spec / round as the
 * verdict and the card) whose approval id is still the owner's current, unrevoked approval. Anything else stays refused.
 */
export function exemptVerdict(db: Database, task: LedgerTask, f: VerdictFacts): boolean {
  const events = listEvents(db, { project: task.project, target: task.id });
  if (!exemptFacts(events, task, f)) return false;
  const want = exemption(refusalEpoch(events, task)!)!.approvalId;
  try {
    const a = createRefusalApprovalPort(db)(task.project, task.id);
    return !!a && a.approvalId === want && a.revoked === false;
  } catch {
    return false; // an unreadable approval is no approval: the gate refuses, the caller's own error says why
  }
}

export type Placement = { family: AuthorFamily; machine: string };
/** The plan an order is built from (its workOrder carries a merge bounce); undefined = rebuild it from the ledger. */
export type OrderPlan = Pick<Extract<PlannerDecision, { kind: "intent" }>, "workOrder"> | null;
/**
 * Why a ticket's materials are no longer the snapshot frozen when it was dispatched, or null (scheduler-model-wiring.ts
 * reviewMaterialCheck: normalized order + every listed file re-hashed). want: the digest MODEL recorded for the refusal; order: a
 * new order (the exempt ticket) that must match the same snapshot. Injected: the order builder sits above the session writer.
 */
export type MaterialCheck = (task: LedgerTask, sent: SchedulerIntent, want: unknown, order?: { intent: SchedulerIntent; plan: OrderPlan }) => string | null;

/** Order material that appeared after the refused ticket was planned: that ticket never saw it, so a resend is not the same. */
const materialAfter = (events: readonly LedgerEvent[], task: Window, sent: Pick<SchedulerIntent, "eventSeq">): boolean =>
  events.some((e) => e.seq > sent.eventSeq && e.kind === "scheduler" && e.data.op === "fix_strategy" && e.data.specRev === task.specRev && e.data.round === task.round);

const refuseEpoch = (why: string): never => { throw new LedgerError("conflict", `不执行拒审接续，退人工：${why}`); };

/** The owner's standing approval as of now, or why it no longer covers this card (same reading MODEL used to plan). */
export function approvalLapse(db: Database, task: LedgerTask, approvalId: unknown): string | null {
  if (task.extra.refusalHold === true) return "owner 已按卡挂起（extra.refusalHold）";
  let a: ReturnType<ReturnType<typeof createRefusalApprovalPort>>;
  try { a = createRefusalApprovalPort(db)(task.project, task.id); } catch (e) { return `读批准失败：${(e as Error).message}`; }
  if (!a || a.approvalId !== approvalId) return "批准 id 与计划不一致";
  if (a.revoked !== false) return "批准已撤销";
  if (a.ownerHold !== false) return "owner 已挂起";
  if (a.content !== "allowed") return "内容未确认允许";
  return null;
}

/** Legacy replacement is an ordinary review, but the refusal authorization must still cover every in-flight effect. */
function legacyReviewLapse(db: Database, task: LedgerTask, events: readonly LedgerEvent[], families?: readonly AuthorFamily[]): string | null {
  const swap = latestReviewerSwap(events);
  if (!swap || swap.data.legacy !== true || events.some((e) => e.seq > swap.seq && e.kind === "review")) return null;
  if (!inWindow(swap, task)) return "旧单接续的 head / specRev / 轮次已变";
  const workflow = getWorkflow(db, task.id);
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review") return "旧单接续已不在本轮自动审查";
  const lapse = approvalLapse(db, task, swap.data.approvalId);
  if (lapse) return lapse;
  if (openRefusal(events)) return "本卡有未处置的模型安全拒绝";
  const family = otherFamily(remoteHeadFamily(db, task) ?? workflow.authorFamily);
  if (families && !families.includes(family)) return `旧单替代审查家族 ${family} 已不在本机授权配置内`;
  return null;
}

/**
 * Where the exempt review may run: only a placement in the current authorized configuration, of the other family, on this
 * machine (the executor creates the reviewer locally; a peer placement has no formal path here). An exempt_review plan's own
 * destination is used as recorded; a legacy retry_same plan (owner 14:45) takes the first authorized one. None → manual.
 */
function exemptPlacement(plan: LedgerEvent, oldFamily: AuthorFamily, authorized: readonly Placement[]): Placement {
  const p = plan.data.plan as { kind: string; to?: Placement };
  const ok = (to: Placement | undefined): to is Placement => !!to && to.family !== oldFamily && to.machine === "local" &&
    authorized.some((a) => a.family === to.family && a.machine === to.machine);
  const to = p.kind === "exempt_review" ? p.to : authorized.find((a) => ok(a));
  if (p.kind === "exempt_review" && to && to.machine !== "local") refuseEpoch(`豁免审查位置 ${to.machine}（${to.family}）不是本机，没有正式执行路径`);
  if (!ok(to)) return refuseEpoch(`已授权位置里没有另一家族（非 ${oldFamily}）可做豁免审查`);
  return { family: to.family, machine: to.machine };
}

/** Every precondition, re-read inside the writer's transaction: the plan event, window, holds, approval, materials, binding, placement. */
function epochFacts(db: Database, task: LedgerTask, planSeq: number, row: SchedulerSession | null, authorized: readonly Placement[], check: MaterialCheck) {
  const events = listEvents(db, { project: task.project, target: task.id });
  const plan = events.find((e) => e.seq === planSeq), d = plan?.data;
  if (!d || (d.op !== RETRY_OP && d.op !== EXEMPT_OP) || d.mode !== "on" || d.cls !== "safety" || d.role !== "reviewer" || d.stale) {
    throw new LedgerError("invalid", `#${planSeq} 不是 MODEL 记下的拒审接续计划`);
  }
  const workflow = getWorkflow(db, task.id);
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review" || !inWindow(plan!, task)) refuseEpoch("head / specRev / 轮次已变");
  if (openSafetyHold(events)) refuseEpoch("本卡有未处置的安全拒绝留证");
  if (events.some((e) => refusalOf(e) && inWindow(e, task))) refuseEpoch("本轮已做过豁免审查，再被拒转人工，不再开 epoch");
  const lapse = approvalLapse(db, task, d.approvalId);
  if (lapse) refuseEpoch(lapse);
  const sent = getIntent(db, String(d.intentId));
  const drift = !sent || sent.head !== task.headSHA || sent.specRev !== task.specRev ? "原审查单不是本轮当前 head / specRev"
    : materialAfter(events, task, sent) ? "原派单后新增了 fix_strategy 材料" : check(task, sent, d.materialDigest);
  if (drift) refuseEpoch(`材料摘要不一致：${drift}`);
  if (!row || row.state !== "active" || row.transport === "peer" || row.sessionId !== d.session || row.family !== d.family) refuseEpoch("被拒的审查员已不是本卡当前绑定");
  return { plan: plan!, approvalId: String(d.approvalId), workflow: workflow!, row: row!, sent: sent!, to: exemptPlacement(plan!, row!.family, authorized) };
}

/**
 * One transaction (the session writer's): the epoch event (dedup refusal-epoch:<plan seq>) and the retired binding, or nothing.
 * authorized: the placements this service may use now (the bound one and this machine's configured families).
 */
export function applyRefusalEpoch(db: Database, ctx: WriteCtx, taskId: string, planSeq: number, row: SchedulerSession | null,
  authorized: readonly Placement[], check: MaterialCheck, migrate: () => void,
  write: (ctx: WriteCtx, event: { project: string; target: string; kind: "scheduler"; text: string; data: Record<string, unknown> }) => LedgerEvent):
  { event: LedgerEvent; duplicate: boolean } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "拒审接续只由调度服务执行");
  const id = refusalEpochId(planSeq), done = getEventByDedup(db, id);
  if (done) return { event: done, duplicate: true };
  const task = mustTask(db, taskId), { plan, approvalId, workflow, row: old, sent, to } = epochFacts(db, task, planSeq, row, authorized, check);
  const author = remoteHeadFamily(db, task) ?? workflow.authorFamily, toFamily = to.family, crossModel = toFamily !== author;
  const planKind = (plan.data.plan as { kind: string }).kind, text = `${EXEMPT_MARK}(批准 ${approvalId})`;
  const owner1445 = planKind === "retry_same" ? "（MODEL 计划 retry_same：owner 14:45 去掉同模型重试，按 exempt_review 执行）" : "";
  migrate();
  const event = write({ ...ctx, dedupKey: id }, { project: task.project, target: task.id, kind: "scheduler",
    text: `${text}：${old.agent}（${old.family}）策略拒审，开新审查 epoch，换 ${toFamily} 独立审一次${crossModel ? "" : "，与作者同家族，不算跨模型"}${owner1445}`,
    data: { op: "reviewer_swap", intentId: sent.id, fromFamily: old.family, toFamily, agent: old.agent, sessionId: old.sessionId,
      round: task.round, head: task.headSHA, specRev: task.specRev,
      refusal: { planSeq, planKind, executed: "exempt_review", approvalId, exemption: text, crossModel, materialDigest: plan.data.materialDigest,
        placement: to, authorized: authorized.map((p) => ({ family: p.family, machine: p.machine })), ...(owner1445 ? { note: "owner 14:45 去掉同模型重试" } : {}) } } });
  db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE sessionId = ?").run(sent.id, ctx.now ?? Date.now(), old.sessionId);
  return { event, duplicate: false };
}

/**
 * Re-checked before every effect of an epoch still in flight (creating the reviewer, after each async lifecycle step, inside the
 * bind transaction, right before the order goes out, and at each tick): why the round's refusal epoch may no longer run, or
 * null. Holds, a revoked / replaced approval, materials no longer the refused ticket's frozen snapshot (and, when given, the new
 * order not matching it either), and — with families — a destination this machine no longer allows. Once the exempt review has a
 * verdict, or MODEL already held its refusal, the epoch is finished and this answers null (the merge gates take over).
 */
export function refusalEpochLapse(db: Database, task: LedgerTask, opts: { check: MaterialCheck; families?: readonly AuthorFamily[];
  order?: { intent: SchedulerIntent; plan: OrderPlan } }): string | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const legacy = legacyReviewLapse(db, task, events, opts.families);
  if (legacy) return legacy;
  const epoch = refusalEpoch(events, task), r = refusalOf(epoch ?? undefined);
  if (!epoch || !r || events.some((e) => e.seq > epoch.seq && (e.kind === "review" || e.data.op === HOLD_OP))) return null;
  const workflow = getWorkflow(db, task.id);
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "review") return "卡已不在本轮自动审查";
  const lapse = approvalLapse(db, task, r.approvalId);
  if (lapse) return lapse;
  const sent = getIntent(db, String(epoch.data.intentId));
  const drift = !sent ? "缺原审查单" : materialAfter(events, task, sent) ? "原派单后新增了 fix_strategy 材料"
    : opts.check(task, sent, r.materialDigest) ?? (opts.order ? opts.check(task, sent, r.materialDigest, opts.order) : null);
  if (drift) return `材料摘要不一致：${drift}`;
  const to = epoch.data.toFamily as AuthorFamily;
  if (opts.families && !opts.families.includes(to)) return `豁免审查家族 ${to} 已不在本机授权配置内`;
  return null;
}

/** The epoch that retired this reviewer binding, when a new ensure_session (planned after it) may bind the other family once. */
export function refusalRebind(db: Database, prior: SchedulerSession, intentId: string, check: MaterialCheck | undefined): LedgerEvent | null {
  if (prior.role !== "reviewer" || prior.state !== "retired" || !prior.retireIntentId) return null;
  const intent = getIntent(db, intentId), epoch = intent && latestReviewerSwap(listEvents(db, { project: intent.project, target: intent.taskId }));
  if (!epoch || !refusalOf(epoch) || epoch.data.intentId !== prior.retireIntentId || epoch.data.sessionId !== prior.sessionId ||
    intent.eventSeq <= epoch.seq) return null;
  const task = mustTask(db, intent.taskId);
  if (!inWindow(epoch, task)) return null;
  if (!check) throw new LedgerError("conflict", "豁免审查员的绑定缺材料快照核对，退人工");
  const lapse = refusalEpochLapse(db, task, { check });
  if (lapse) throw new LedgerError("conflict", `不绑定豁免审查员，退人工：${lapse}`);
  return epoch;
}

/** The bind event's marks under a refusal epoch: the exemption text and approval id when it binds the author's family. */
export function refusalBindMarks(epoch: LedgerEvent): Record<string, unknown> {
  const r = refusalOf(epoch)!;
  return { refusalEpoch: epoch.seq, approvalId: r.approvalId, crossModel: r.crossModel, ...(r.crossModel ? {} : { exemption: r.exemption }) };
}
