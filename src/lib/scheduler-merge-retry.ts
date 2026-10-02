/**
 * i28-MR1：合并意图被取消后，PM 核对过外部结果（merge_resolve failed / cancelled）再交回自动（workflow_resume），
 * planner 就当 PM 已放行，自己排一次新的合并，不再退回人工。纯函数，只读快照里的事件与意图。
 * 每次放行只对应一次重试：重试的意图再被取消，它自己没有 resolve + 交回，就照旧退回 PM。
 * 卡上 head 必须是被取消意图审过的 head，或只经调度器沿用审查（review_carry，纯 main 合入）从它走到；否则不放行。
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";

const sameSha = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** 被取消意图审过的 head 经它自己的 review_carry 链（调度器写的）走到卡上 head 才算纯 main 合入 */
function headReachable(events: readonly LedgerEvent[], intent: SchedulerIntent, cardHead: string): boolean {
  if (!intent.head) return false;
  let head = intent.head;
  for (const e of events) {
    if (e.kind !== "scheduler" || e.data.op !== "review_carry" || e.data.intentId !== intent.id || e.actor !== "scheduler") continue;
    if (typeof e.data.from === "string" && typeof e.data.to === "string" && sameSha(e.data.from, head)) head = e.data.to;
  }
  return sameSha(head, cardHead);
}

/** 这个被取消的合并意图是否已由 PM 核对（failed / cancelled）并在之后交回自动 */
export function mergeRetryReleased(task: LedgerTask, events: readonly LedgerEvent[], cancelled: SchedulerIntent): boolean {
  if (cancelled.action !== "merge" || cancelled.status !== "cancelled" || !task.headSHA) return false;
  const resolve = events.findLast((e) => e.kind === "scheduler" && e.data.op === "merge_resolve" && e.data.intentId === cancelled.id &&
    e.data.manual === true && e.actor !== "scheduler");
  if (!resolve || (resolve.data.outcome !== "failed" && resolve.data.outcome !== "cancelled")) return false;
  const resumed = events.some((e) => e.kind === "scheduler" && e.seq > resolve.seq && e.data.op === "workflow_resume" && e.data.manual === true);
  return resumed && headReachable(events, cancelled, task.headSHA);
}
