/** Reviewer epochs: an author-family takeover invalidates the old binding, not its audit history. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
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

type SwapSnapshot = Pick<PlannerSnapshot, "task" | "workflow" | "events" | "reviewer"> & { author: { agent: string } | null };

function swapNeeded(s: SwapSnapshot): boolean {
  const r = s.reviewer;
  if (!r || r.source !== "local" || r.taskId !== s.task.id || !r.agent || !r.sessionId || s.task.round < 2) return false;
  const prior = reviewsAfterSwap(s.events).find((e) => !String(e.data.reviewer ?? "").startsWith("peer:"));
  // A different, unapproved session is still reviewer_replaced, not permission to start another epoch.
  if (prior && (prior.data.reviewer !== r.agent || prior.data.reviewerSessionId !== r.sessionId)) return false;
  return r.family === s.workflow?.authorFamily || (r.agent === s.author?.agent || r.agent === s.task.agent);
}

/** Keep invalid legacy bindings on sessionGate's existing error path; only a swap may release a bound reviewer to the pool. */
export const keepsReviewer = (s: PlannerSnapshot): boolean => !!s.reviewer && (independentReviewer(s) || !swapNeeded(s));

/** Runs before placement and again at sessionGate: retiring the old session must precede any peer/local dispatch. */
export function reviewSwapPlan(s: PlannerSnapshot, node: string, place: typeof reviewPlacement): PlannerDecision | null {
  const swap = latestReviewerSwap(s.events);
  if (swapNeeded(s)) {
    // A model safety refusal outranks the family switch: swapping in would fetch the refused content from another model.
    const hold = openRefusal(s.events);
    if (hold) return { kind: "escalate", code: "model_safety_hold", reason: `本卡有未处置的模型安全拒绝（#${hold.seq}），不自动换家族审查，等 PM / owner 处置或批准的接续审查完成` };
    if (swap?.data.round === s.task.round) return { kind: "escalate", code: "reviewer_independence", reason: "本轮已换过审查员，新会话仍与当前作者不独立" };
    const born = s.events.find((e) => e.kind === "task")?.seq ?? 0;
    return { kind: "intent", id: `review-swap:s${born}:r${s.task.round}`, node, action: "review_swap", recipient: null,
      resources: [`task:s${born}`], observedOnly: s.workflow?.mode === "observe",
      reason: `作者家族由 ${s.reviewer!.family === "claude" ? "codex" : "claude"} 变成 ${s.workflow!.authorFamily}，更换不独立的审查会话` };
  }
  if (!swap || s.reviewer) return null;
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

/** A hold, or an approved refusal continuation still waiting for its review: either way no automatic family switch. */
export function openRefusal(events: readonly LedgerEvent[]): LedgerEvent | null {
  const hold = openSafetyHold(events);
  if (hold) return hold;
  const cont = events.findLast((e) => e.data.op === RETRY_OP || e.data.op === EXEMPT_OP);
  return cont && !events.some((e) => e.seq > cont.seq && e.kind === "review") ? cont : null;
}

/** The task's unresolved model safety hold (scheduler-model-outcome.ts writes it), or null. Only a manager's resolve lifts it. */
export function openSafetyHold(events: readonly LedgerEvent[]): LedgerEvent | null {
  const hold = events.findLast((e) => e.data.op === HOLD_OP);
  if (!hold) return null;
  return events.some((e) => e.seq > hold.seq && e.data.op === RESOLVE_OP && e.data.holdSeq === hold.seq) ? null : hold;
}

const swapKey = (id: string): string => `scheduler:${id}:reviewer-swap`;

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
  const family = remoteHeadFamily(db, task) ?? workflow.authorFamily;
  const author = db.query("SELECT agent FROM scheduler_sessions WHERE taskId = ? AND role = 'author' AND state != 'retired'")
    .get(task.id) as { agent: string } | null;
  const s: SwapSnapshot = { task, workflow: { ...workflow, authorFamily: family }, events, author,
    reviewer: row?.state === "active" ? { ...row, source: row.transport === "peer" ? "peer_claim" : "local" } : null };
  if (!row || !swapNeeded(s) || latestReviewerSwap(events)?.data.round === task.round) throw new LedgerError("conflict", "本轮不允许再次更换审查员");
  if (openRefusal(events)) throw new LedgerError("conflict", "本卡有未处置的模型安全拒绝，不自动更换审查员");
  migrate();
  settleIntent(db, ctx, { id, from: "pending", to: "submitted", receipt: "claimed; 更换不独立的审查员" });
  const fromFamily = row.family === "claude" ? "codex" : "claude";
  write({ ...ctx, dedupKey: swapKey(id) }, { project: task.project, target: task.id, kind: "scheduler",
    text: `作者家族由 ${fromFamily} 变成 ${family}，旧审查会话不再独立`,
    data: { op: "reviewer_swap", intentId: id, fromFamily, toFamily: family, agent: row.agent, sessionId: row.sessionId,
      round: task.round, head: task.headSHA, specRev: task.specRev } });
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
  if (!prior.killReceipt && !reused) return false;
  const swap = getEventByDedup(db, swapKey(prior.retireIntentId));
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
