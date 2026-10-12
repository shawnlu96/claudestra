/**
 * 「审查通过但留有 P2」那条 PM 通知的分流（agents-PMAUTO1）：scheduler-auto-tick.ts diffNotice 把拼好的原文交到这里，只接这一行。
 * - p2BacklogMode off：原文原样发，不读、不调别的。
 * - observe：经调度身份的 `ledger p2-backlog-record` 在卡上记一条「本会入积压」，原文照发。
 * - on：先让台账把普通 P2 持久入积压，成功了才把通知换成一行摘要（PMROUTE1 归 digest）；还有要 PM 判断的 P2（范围 / 权限 / 归不了类）时
 *   原文照发并注明是哪几条；入积压失败、结论对不上、任何异常 → 原文原样发。P2 从不因此挡住本来能合的卡：这里只决定通知怎么发。
 * tests/p2-backlog.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { p2BacklogMode } from "./p2-backlog-mode.js";

export interface P2NoticeDeps {
  manager(...args: string[]): Promise<Record<string, unknown>>;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
}

/** 这条通知最终发什么；记账失败时返回原文。 */
export async function p2NoticeText(db: Database, task: LedgerTask, original: string, manager: P2NoticeDeps["manager"]): Promise<string> {
  const mode = p2BacklogMode(db, task.project);
  if (mode === "off") return original;
  try {
    const review = listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "review");
    if (!review) return original;
    const r = await manager("ledger", "p2-backlog-record", task.id, "--review-seq", String(review.seq), "--mode", mode);
    if (mode !== "on" || r.ok !== true) return original;
    const judge = Array.isArray(r.judge) ? r.judge as { findingId: string; why: string }[] : [];
    if (judge.length) {
      return `${original}；需 PM 判断的 P2：${judge.map((j) => `${j.findingId}（${j.why}）`).join("、")}${typeof r.digest === "string" ? `；其余已入积压，见 ledger p2-backlog` : ""}`;
    }
    return typeof r.digest === "string" && r.digest ? r.digest : original;
  } catch (e) {
    console.error(`⚠️ ${task.id} 的 P2 入积压没做成，照旧发原通知：${(e as Error).message}`);
    return original;
  }
}

/** diffNotice 的一行接线：`await p2DiffNotice(this.db, this.task, text, this.deps)`。 */
export async function p2DiffNotice(db: Database, task: LedgerTask, original: string, deps: P2NoticeDeps): Promise<void> {
  await deps.notifyPm(task, await p2NoticeText(db, task, original, deps.manager));
}
