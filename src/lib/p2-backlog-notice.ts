/**
 * 「审查通过但留有 P2」那条 PM 通知的分流（agents-PMAUTO1）：scheduler-auto-tick.ts diffNotice 把拼好的原文交到这里，只接这一行。
 * - p2BacklogMode off：原文原样发，不读、不调别的。
 * - observe：经调度身份的 `ledger p2-backlog-record` 在卡上记一条「本会入积压」，原文照发。
 * - on：先让台账把普通 P2 持久入积压，成功了才把通知换成一行摘要（PMROUTE1 归 digest）；还有要 PM 判断的 P2（范围 / 权限 / 归不了类）时
 *   原文照发并注明是哪几条；入积压失败、结论对不上、任何异常 → 原文原样发。P2 从不因此挡住本来能合的卡：这里只决定通知怎么发。
 * - 入积压成功后再看 pmTodoPull（agents-PULLTODO1，pm-todo-p2.ts）：on 时整条改记 pm-todo、不调 notifyPm；写不进去照旧推送。
 * tests/p2-backlog.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { p2BacklogMode } from "./p2-backlog-mode.js";
import { p2TodoInstead, type P2Todo, type P2TodoDeps } from "./pm-todo-p2.js";

export interface P2NoticeDeps extends P2TodoDeps {
  notifyPm(task: LedgerTask, text: string): Promise<void>;
}

const TODO_MAX = 3800;
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim();

/** 这条通知最终发什么；todo = P2 已入积压时改记 pm-todo 的内容（卡号、head、报告路径、需 PM 判断的 P2）。记账失败时只有原文。 */
async function p2Notice(db: Database, task: LedgerTask, original: string, manager: P2NoticeDeps["manager"]): Promise<{ text: string; todo?: P2Todo }> {
  const mode = p2BacklogMode(db, task.project);
  if (mode === "off") return { text: original };
  try {
    const review = listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "review");
    if (!review) return { text: original };
    const r = await manager("ledger", "p2-backlog-record", task.id, "--review-seq", String(review.seq), "--mode", mode);
    if (mode !== "on" || r.ok !== true) return { text: original };
    const judge = Array.isArray(r.judge) ? r.judge as { findingId: string; why: string }[] : [];
    const listed = judge.map((j) => `${j.findingId}（${j.why}）`).join("、");
    const rest = typeof r.digest === "string" ? `；其余已入积压，见 ledger p2-backlog` : "";
    const todoText = oneLine(`${task.id} 审查通过留 P2：head ${String(review.data.head ?? task.headSHA)}，报告 ${String(review.data.path ?? "（无）")}；需 PM 判断的 P2：${listed || "无"}${rest}`);
    const todo = { reviewSeq: review.seq, text: [...todoText].length > TODO_MAX ? `${[...todoText].slice(0, TODO_MAX).join("")}…` : todoText };
    if (judge.length) return { text: `${original}；需 PM 判断的 P2：${listed}${rest}`, todo };
    return { text: typeof r.digest === "string" && r.digest ? r.digest : original, todo };
  } catch (e) {
    console.error(`⚠️ ${task.id} 的 P2 入积压没做成，照旧发原通知：${(e as Error).message}`);
    return { text: original };
  }
}

/** 推给 PM 的那条通知发什么（pmTodoPull 改记 pm-todo 时不发，见 p2DiffNotice） */
export async function p2NoticeText(db: Database, task: LedgerTask, original: string, manager: P2NoticeDeps["manager"]): Promise<string> {
  return (await p2Notice(db, task, original, manager)).text;
}

/** diffNotice 的一行接线：`await p2DiffNotice(this.db, this.task, text, this.deps)`。 */
export async function p2DiffNotice(db: Database, task: LedgerTask, original: string, deps: P2NoticeDeps): Promise<void> {
  const n = await p2Notice(db, task, original, deps.manager);
  if (await p2TodoInstead(task, n.todo, deps)) return;
  await deps.notifyPm(task, n.text);
}
