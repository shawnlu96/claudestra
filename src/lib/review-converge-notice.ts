/**
 * PM's notice when a card hits the review round cap (review-converge.ts roundCap): the card holds (no new work, mode stays
 * auto) and PM hears once per verdict, with every round's blocking P1s. "Once" lives in memory per ledger: a lost notice is
 * retried next tick, and a restart re-sends a standing cap at most once more — the hold itself is the durable state, the
 * planner re-derives it from the ledger every pass. tests/review-converge-notice.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { MAX_REVIEW_ROUND } from "./review-converge.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { countsAsP1, type ReviewFinding } from "./scheduler-review.js";

const told = new WeakMap<Database, Set<string>>();
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
  const events = listEvents(db, { project: task.project, target: task.id });
  const verdict = events.findLast((e) => e.kind === "review" && e.data.round === task.round)?.seq ?? 0;
  const key = `${task.id}@${verdict}`;
  const seen = told.get(db) ?? told.set(db, new Set()).get(db)!;
  if (seen.has(key)) return `第 ${task.round} 轮到上限，等 PM 交回（已通知）`;
  try {
    await notifyPm(task, roundCapText(task, events));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // a lost lease ends the pass, like every other notice in scheduler-auto-tick.ts
    console.error(`⚠️ [scheduler] 轮次上限通知没发出去（下个 tick 重发）：${(e as Error).message}`);
    return `第 ${task.round} 轮到上限，通知 PM 没发出去，下个 tick 重发`;
  }
  seen.add(key);
  return `第 ${task.round} 轮到上限，已通知 PM`;
}
