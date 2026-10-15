/**
 * 「审查通过留 P2」只进 pm-todo（agents-PULLTODO1，恢复键 pmTodoPull，缺省 on；判定见 pm-todo-audit.ts pmTodoPullMode）：
 * p2-backlog-notice.ts 在 P2 已入积压（p2BacklogMode on 且台账确认）后交到这里——
 * - on：经调度身份的 `ledger scheduler-pm-todo` 在卡上记一条待办（卡号、head、报告路径、需 PM 判断的 P2），不调 notifyPm；写不进去照旧推送。
 * - observe：照旧推送，经 `ledger scheduler-recovery-observe` 记一条「本会只进 pm-todo」。
 * - off：与改前一致。tests/pm-todo-p2.test.ts。
 */
import type { LedgerTask } from "./ledger-stages.js";
import { pmTodoPullMode } from "./pm-todo-audit.js";
import type { RecoveryPolicyPort } from "./recovery-policy.js";

export const P2_TODO_KIND = "p2_review";

/** 本该推给 PM 的那条 P2 通知换成待办所需的内容；只有 P2 已入积压时才有 */
export interface P2Todo { reviewSeq: number; text: string }

export interface P2TodoDeps {
  manager(...args: string[]): Promise<Record<string, unknown>>;
  /** 单测注入；不给 = recovery-policy.json */
  recoveryPolicy?: RecoveryPolicyPort;
}

/** true = 已记成待办，不必再推送 */
export async function p2TodoInstead(task: LedgerTask, todo: P2Todo | undefined, deps: P2TodoDeps): Promise<boolean> {
  if (!todo) return false;
  const mode = pmTodoPullMode(task.project, deps.recoveryPolicy);
  if (mode === "off") return false;
  try {
    if (mode === "observe") {
      await deps.manager("ledger", "scheduler-recovery-observe", task.id, "--mechanism", "pmTodoPull", "--action-key", `p2:${todo.reviewSeq}`,
        "--action", "审查通过留 P2 的通知只进 pm-todo、不推送");
      return false;
    }
    const r = await deps.manager("ledger", "scheduler-pm-todo", task.id, "--kind", P2_TODO_KIND, "--text", todo.text, "--dedup", `p2-todo:${task.id}:${todo.reviewSeq}`);
    if (r.ok === true) return true;
    console.error(`⚠️ ${task.id} 的 P2 待办没记上，照旧推送：${String(r.error ?? "")}`);
  } catch (e) {
    console.error(`⚠️ ${task.id} 的 P2 待办 / 观察没记上${mode === "on" ? "，照旧推送" : ""}：${(e as Error).message}`);
  }
  return false;
}
