/**
 * UXPAUSE1 · the pause / resume transactions behind `ledger card-pause` / `card-resume` (card-pause.ts is the read side the gates use).
 * Pause, in one transaction: withdraw the card's unclaimed pool orders (closePoolOrders), cancel its pending intents (as
 * scheduler-fallback.ts does), record the `card_pause` decision. Submitted / done intents, claimed pool orders, stage, round, head,
 * workflow mode / rev and file locks are left as they are, so resume needs nothing but the `card_resume` decision: the next pass
 * plans from the current stage and regenerates what was cancelled.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { closePoolOrders } from "./ledger-scheduler-pool.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { intentOf, listRequests, revokeOf } from "./manual-merge-queue-facts.js";
import { CARD_PAUSE_OP, CARD_RESUME_OP, cardPauseMode, cardPauseState, PAUSABLE_STAGES, safe, type CardPauseState } from "./card-pause.js";

/** An unsettled manual merge request of the card (not revoked, its claim — if any — not finished): its seq, or null. */
function openManualMergeRequest(db: Database, task: Pick<LedgerTask, "id" | "project">): number | null {
  return safe(() => {
    const open = listRequests(db, task.project, task.id).find((r) => {
      if (revokeOf(db, r)) return false;
      const intent = intentOf(db, r);
      return !intent || ["pending", "submitted", "unknown"].includes(intent.status);
    });
    return open?.seq ?? null;
  }, null);
}

/** Why `card-pause` refuses this card now (switch off, stage, open manual merge request), or null when it may be paused. */
export function pauseRefusal(db: Database, task: Pick<LedgerTask, "id" | "project" | "stage">): string | null {
  if (cardPauseMode(task.project) === "off") return `项目 ${task.project} 的卡级暂停开关（cardPause）关着：不能暂停，已暂停的卡仍可继续`;
  if (!PAUSABLE_STAGES.includes(task.stage)) {
    return `${task.id} 在 ${task.stage} 阶段，不能暂停（只有 ${PAUSABLE_STAGES.join(" / ")} 能停；合并阶段要停请 PM 撤出合并队列）`;
  }
  const req = openManualMergeRequest(db, task);
  return req === null ? null : `${task.id} 有未结的人工合并请求 #${req}，不能暂停；先撤回请求`;
}

function authorize(db: Database, ctx: WriteCtx, task: LedgerTask, what: string): void {
  if (!actorMayConfigure(db, ctx.actor, task.project)) {
    throw new LedgerError("forbidden", `${what}要项目 ${task.project} 的 PM（调度助理除外）/ master / owner（你是 ${ctx.actor}）`);
  }
}

export interface CardPauseResult { duplicate: boolean; state: CardPauseState | null; cancelledIntents?: string[]; poolOrders?: { withdrawn: string[]; stray: string[] } }

export function pauseCard(db: Database, ctx: WriteCtx, input: { taskId: string; reason: string }): CardPauseResult {
  const reason = textOneLine(input.reason, "暂停理由", 600);
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    authorize(db, ctx, task, "暂停卡");
    const prior = cardPauseState(db, task.id);
    if (prior?.paused) return { duplicate: true, state: prior };
    const refusal = pauseRefusal(db, task);
    if (refusal) throw new LedgerError("conflict", refusal, { stage: task.stage });
    const now = ctx.now ?? Date.now();
    const pool = closePoolOrders(db, { ...ctx, now }, task.id, `卡暂停：${reason}`);
    const pending = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status = 'pending'").all(task.id) as { id: string }[];
    db.query("UPDATE scheduler_intents SET status = 'cancelled', updatedAt = ? WHERE taskId = ? AND status = 'pending'").run(now, task.id);
    for (const row of pending) db.query("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(row.id);
    const cancelledIntents = pending.map((p) => p.id);
    insertEvent(db, { ...ctx, now }, { project: task.project, target: task.id, kind: "decision", text: reason,
      data: { op: CARD_PAUSE_OP, mode: cardPauseMode(task.project), stage: task.stage, round: task.round, head: task.headSHA, cancelledIntents,
        ...(pool.withdrawn.length || pool.stray.length ? { poolOrders: pool } : {}) } }, true);
    return { duplicate: false, state: cardPauseState(db, task.id), cancelledIntents, poolOrders: pool };
  });
}

/** Allowed under every switch position, so turning the switch off can always release an old pause. */
export function resumeCard(db: Database, ctx: WriteCtx, input: { taskId: string }): CardPauseResult {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    authorize(db, ctx, task, "继续卡");
    const prior = cardPauseState(db, task.id);
    if (!prior?.paused) return { duplicate: true, state: prior };
    insertEvent(db, { ...ctx, now: ctx.now ?? Date.now() }, { project: task.project, target: task.id, kind: "decision",
      text: `继续调度（解除 #${prior.seq} 的暂停）`, data: { op: CARD_RESUME_OP, pauseSeq: prior.seq } }, true);
    return { duplicate: false, state: cardPauseState(db, task.id) };
  });
}
