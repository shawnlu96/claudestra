/** Recovery of a legacy replacement whose source round has passed; checkout authorization stays with its existing rule. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, taskCreationSeq } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { boundReviewSource } from "./scheduler-review-checkout.js";
import { openRefusal, swappedSession, swapKey } from "./scheduler-review-swap.js";
import { getSchedulerSession, preserveSessionHistory, type SchedulerSession } from "./scheduler-sessions.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { PlannerDecision, PlannerSnapshot, WorkerRef } from "./scheduler-plan.js";

export interface StaleReplacement {
  mode: Exclude<RecoveryMode, "off">;
  session: SchedulerSession;
  source: NonNullable<ReturnType<typeof boundReviewSource>>;
}

/** Shared with stopOld: use the same live executor/binding exclusions before planning or stopping an agent. */
export function sharedReviewAgent(db: Database, agent: string, excludedTask: string): unknown {
  return db.query(`SELECT id FROM tasks WHERE stage NOT IN ('verified','done','cancelled') AND agent = ? AND id != ? UNION
    SELECT taskId AS id FROM scheduler_sessions WHERE agent = ? AND state != 'retired' AND taskId != ? LIMIT 1`)
    .get(agent, excludedTask, agent, excludedTask);
}

/** Read-only facts also run inside the retirement transaction; off and every non-matching shape leave no snapshot field. */
export function staleReplacementFact(db: Database, task: LedgerTask): StaleReplacement | null {
  const mode = recoveryPolicy(task.project, "staleReplacement").mode;
  if (mode === "off" || task.stage !== "review") return null;
  const workflow = getWorkflow(db, task.id), session = getSchedulerSession(db, task.id, "reviewer");
  if (workflow?.mode !== "auto" || workflow.specRev !== task.specRev || !session || session.state !== "active" || session.transport === "peer") return null;
  const source = boundReviewSource(db, task, session);
  if (!source || source.tag !== "-re" || typeof source.swap.data.round !== "number" || source.swap.data.round >= task.round) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  if (openRefusal(events) || events.some((e) => e.seq > source.swap.seq && e.kind === "review" && e.data.round === task.round &&
    e.data.head === task.headSHA)) return null;
  const author = getSchedulerSession(db, task.id, "author");
  if (session.agent === task.agent || (author?.state !== "retired" && author?.agent === session.agent) ||
    sharedReviewAgent(db, session.agent, task.id)) return null;
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get() &&
    db.query("SELECT 1 FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown') LIMIT 1").get(task.id)) return null;
  return { mode, session, source };
}

const sameReviewer = (ref: WorkerRef | null, fact: StaleReplacement): boolean => !!ref && ref.source === "local" &&
  ref.taskId === fact.session.taskId && ref.agent === fact.session.agent && ref.sessionId === fact.session.sessionId && ref.family === fact.session.family;
const staleId = (born: number, round: number): string => `review-stale:s${born}:r${round}`;

const staleReason = (fact: StaleReplacement): string =>
  `退休 ${fact.session.agent}（${fact.source.tag}，来源第 ${fact.source.swap.data.round} 轮，swap #${fact.source.swap.seq}，session ${fact.session.sessionId}）` +
  "的过期审查绑定，按当前 head 重建审查员";

/** Pure planner port: a cancelled retirement is never retried under this round's stable id. */
export function staleReplacementPlan(s: PlannerSnapshot): PlannerDecision | null {
  const fact = s.staleReplacement;
  if (!fact || fact.mode !== "on" || !sameReviewer(s.reviewer, fact)) return null;
  const born = s.events.find((e) => e.kind === "task")?.seq ?? 0, id = staleId(born, s.task.round);
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === "review")?.seq ?? born;
  if (s.intents.some((i) => i.id === id || (i.node === "adversarial_review" && i.action === "review" &&
    i.causalSeq >= since && i.status !== "cancelled"))) return null;
  return { kind: "intent", id, node: "adversarial_review", action: "review_swap", recipient: null, resources: [`task:s${born}`], observedOnly: false,
    reason: staleReason(fact) };
}

/** Observe uses the existing fallback write port; the cancelled intent keeps the pin's original receipt. */
export function staleReplacementObservation(db: Database, task: LedgerTask, ref: WorkerRef, original: string): string {
  const fact = staleReplacementFact(db, task);
  if (!fact || fact.mode !== "observe" || !sameReviewer(ref, fact)) return original;
  return `review_source_missing: ${original};恢复观察 staleReplacement:本会退休 ${fact.session.agent}` +
    `(${fact.source.tag},来源第 ${fact.source.swap.data.round} 轮)的审查绑定,先归档再停止,再按当前 head 重建审查员`;
}

/** Identity and ownership precede replay; first execution re-proves all facts before any write in one transaction. */
export function beginStaleReviewerSwap(db: Database, ctx: WriteCtx, id: string): SchedulerSession {
  return tx(db, () => {
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "更换审查员只由调度服务执行");
    const intent = getIntent(db, id);
    if (!intent || intent.action !== "review_swap" || intent.node !== "adversarial_review") throw new LedgerError("conflict", "缺过期替代退休意图");
    const task = mustTask(db, intent.taskId), born = taskCreationSeq(db, task.id);
    if (born === null || id !== staleId(born, task.round) || intent.project !== task.project) throw new LedgerError("conflict", "不是本卡本轮退休意图");
    if (getEventByDedup(db, swapKey(id))) return swappedSession(db, id);
    const fact = staleReplacementFact(db, task);
    if (intent.status !== "pending" || intent.taskRev !== task.rev || intent.specRev !== task.specRev || intent.head !== task.headSHA || !fact ||
      fact.mode !== "on" || intent.eventSeq <= fact.source.created.eventSeq) throw new LedgerError("conflict", "过期替代退休计划已变化，先重算");
    // No schema change is needed to freeze the source: planIntent already replays the pure planner's exact reason.
    if (staleReason(fact) !== intent.reason ||
      db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND id != ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id, id)) {
      throw new LedgerError("conflict", "退休来源或未结意图已变化，先重算");
    }
    const family = remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)!.authorFamily;
    preserveSessionHistory(db);
    settleIntent(db, ctx, { id, from: "pending", to: "submitted", receipt: "claimed; 退休过期替代审查绑定" });
    const { swap, tag } = fact.source, row = fact.session;
    insertEvent(db, { ...ctx, dedupKey: swapKey(id) }, { project: task.project, target: task.id, kind: "scheduler", text: intent.reason,
      data: { op: "reviewer_swap", intentId: id, fromFamily: row.family, toFamily: family, agent: row.agent, sessionId: row.sessionId,
        round: task.round, head: task.headSHA, specRev: task.specRev,
        stale: { seq: swap.seq, tag, head: swap.data.head, specRev: swap.data.specRev, round: swap.data.round } } }, true);
    db.query("UPDATE scheduler_sessions SET state = 'retired', retireIntentId = ?, updatedAt = ? WHERE sessionId = ?")
      .run(id, ctx.now ?? Date.now(), row.sessionId);
    return swappedSession(db, id);
  });
}
