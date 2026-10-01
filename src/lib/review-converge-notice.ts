/**
 * PM's notice when a card hits the review round cap (review-converge.ts roundCap): the card holds (no new work, mode stays
 * auto) and PM hears once per verdict, with every round's blocking P1s. The sent receipt survives restarts; a failed send
 * is retried next tick. The planner re-derives the hold from the ledger every pass. tests/scheduler-plan-converge.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { MAX_REVIEW_ROUND, ROUND_CAP_CODE } from "./review-converge.js";
import { convergeReview } from "./review-converge.js";
import { convergeFollowUp } from "./review-converge-followup.js";
import { fixDiffOf } from "./review-converge-scope.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { countsAsP1, currentReviewFacts, type ReviewFinding } from "./scheduler-review.js";

export const isRoundCap = (code: string): boolean => code === ROUND_CAP_CODE;
const PER_ROUND = 6;

/** One line per round: the P1s that still blocked then (named a basis, not demoted). */
export function p1Summary(events: readonly LedgerEvent[], upTo: number): string[] {
  const byRound = new Map<number, ReviewFinding[]>();
  for (const e of events) {
    if (e.kind === "review" && typeof e.data.round === "number" && e.data.round <= upTo && Array.isArray(e.data.findings)) {
      byRound.set(e.data.round, (e.data.findings as ReviewFinding[]).filter((f) => f && typeof f === "object" && countsAsP1(events, e.data.round as number, f)));
    }
  }
  return [...byRound.entries()].sort(([a], [b]) => a - b).map(([round, rows]) => {
    const names = rows.slice(0, PER_ROUND).map((f) => `${f.findingId}（${f.family}）`);
    return `r${round}：${rows.length ? names.join("、") + (rows.length > PER_ROUND ? ` 等 ${rows.length} 项` : "") : "无"}`;
  });
}

export function roundCapText(task: Pick<LedgerTask, "id" | "round">, events: readonly LedgerEvent[]): string {
  return `[调度引擎] ${task.id} 审查到第 ${task.round} 轮仍有挂验收线的 P1（上限 ${MAX_REVIEW_ROUND} 轮），已停下：不派新活，流程仍是 auto。` +
    `每轮 P1：${p1Summary(events, task.round).join("；")}。请拆卡或改规格后 workflow-resume 交回（规格不变时先 workflow-set --mode manual 再交回）。`;
}

/** Tell PM once per capped verdict; returns the card outcome detail. */
export async function roundCapNotice(db: Database, task: LedgerTask, notifyPm: (t: LedgerTask, text: string) => Promise<void>): Promise<string> {
  let events = listEvents(db, { project: task.project, target: task.id });
  const review = currentReviewFacts(task, events);
  if (review.kind === "facts") {
    const { downgrade } = convergeReview(events, review.facts, fixDiffOf(task, events));
    // A capped verdict has no stage move to carry its nonblocking findings; keep their drafts here instead.
    if (downgrade) tx(db, () => convergeFollowUp(db, { actor: "scheduler" }, task, downgrade));
    events = listEvents(db, { project: task.project, target: task.id });
  }
  const verdict = events.findLast((e) => e.kind === "review" && e.data.round === task.round)?.seq ?? 0;
  const key = `scheduler:review-cap:${task.id}:${verdict}`;
  if (getEventByDedup(db, key)) return `第 ${task.round} 轮到上限，等 PM 交回（已通知）`;
  const text = roundCapText(task, events);
  try {
    await notifyPm(task, text);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // a lost lease ends the pass, like every other notice in scheduler-auto-tick.ts
    console.error(`⚠️ [scheduler] 轮次上限通知没发出去（下个 tick 重发）：${(e as Error).message}`);
    return `第 ${task.round} 轮到上限，通知 PM 没发出去，下个 tick 重发`;
  }
  tx(db, () => {
    if (!getEventByDedup(db, key)) insertEvent(db, { actor: "scheduler", dedupKey: key }, {
      project: task.project, target: task.id, kind: "scheduler", text,
      data: { op: "review_round_hold", round: task.round, reviewSeq: verdict, informed: true },
    }, true);
  });
  return `第 ${task.round} 轮到上限，已通知 PM`;
}

/** Failed follow-ups stay visible to PM even after the original card advances to merge. */
export async function followUpFailureNotice(db: Database, task: LedgerTask,
  notifyPm: (t: LedgerTask, text: string) => Promise<void>): Promise<void> {
  const failed = listEvents(db, { project: task.project, target: task.id })
    .filter((e) => e.data.op === "review_downgrade" && typeof e.data.followUpFailure === "string");
  for (const e of failed) {
    const key = `scheduler:converge-notice:${task.id}:${e.seq}`;
    if (getEventByDedup(db, key)) continue;
    const text = `[调度引擎] ${task.id} 第 ${e.data.round} 轮降级发现的后续节点未建立，请 PM 补建：${e.data.followUpFailure}；报告 ${e.data.reportPath}`;
    try { await notifyPm(task, text); }
    catch (error) {
      if (error instanceof SchedulerStopped) throw error;
      console.error(`[scheduler] 后续节点失败通知未发送，下个 tick 重试：${(error as Error).message}`);
      return;
    }
    tx(db, () => {
      if (!getEventByDedup(db, key)) insertEvent(db, { actor: "scheduler", dedupKey: key }, {
        project: task.project, target: task.id, kind: "scheduler", text,
        data: { op: "review_followup_failed", downgradeSeq: e.seq, informed: true },
      }, true);
    });
  }
}
