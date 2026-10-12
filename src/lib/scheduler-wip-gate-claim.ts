/**
 * WIP 闸（dispatch-recovery-WIPGATE1）的准入事实与认领事务里的重核：卡开没开过工（neverStarted）、哪些意图算作者首次开工（authorStart），
 * 以及两个重核点——调度服务认领作者首次开工意图（ledger-scheduler-settle.ts settleIntent，pending→submitted，同一事务）和挂首张 write 单
 * （ledger-scheduler-pool.ts）。只在 on 且深度 ≥ 阈值时拒绝（conflict 回滚，意图原样留 pending，下一轮重判）；off / observe、读不到开关或深度一律放行。
 * 认领一经提交即准入，之后本机建作者不因队列晚涨回滚（同 DAG 自动 claim）。
 * 合并队列深度要走调度计划（ledger-merge-queue-view.ts），后者又会回到 settle，故判定由 scheduler-wip-gate.ts 加载时注入（没注入 = 不拦，同 off）。
 */
import type { Database } from "bun:sqlite";
import type { IntentStatus, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";

/** 卡从没开过工（首次自动准入）；任何一项读不出来都按开过工处理（不拦） */
export function neverStarted(db: Database, task: Pick<LedgerTask, "id" | "agent">): boolean {
  if (task.agent) return false;
  const id = task.id;
  const facts: [string, ...string[]][] = [
    ["SELECT 1 FROM events WHERE kind = 'feature' AND json_extract(data, '$.op') = 'autostart_claim' AND json_extract(data, '$.taskId') = ?", id],
    ["SELECT 1 FROM events WHERE dedupKey >= ? AND dedupKey < ?", `dag-start:${id}:`, `dag-start:${id};`], // start_node（dag-tools-steps.ts dedup）
    ["SELECT 1 FROM scheduler_sessions WHERE taskId = ? AND role = 'author'", id],
    ["SELECT 1 FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch' AND status IN ('submitted','done','unknown')", id],
    ["SELECT 1 FROM events WHERE target = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = 'pool_offer'", id],
    ["SELECT 1 FROM lend_write_leases WHERE taskId = ?", id],
    ["SELECT 1 FROM lend_orders WHERE taskId = ?", id],
  ];
  try {
    return facts.every(([sql, ...args]) => db.query(`${sql} LIMIT 1`).get(...args) === null);
  } catch {
    return false;
  }
}

/** 作者的第一份工作：复述 / 开工节点上的建会话或派单；修复、审查、合并、收尾、阶段推进都不算 */
export const authorStart = (w: Pick<SchedulerIntent, "action" | "node">): boolean =>
  (w.action === "ensure_session" || w.action === "dispatch") && (w.node === "restate" || w.node === "write");

type Recheck = (db: Database, task: LedgerTask) => string | null;
let recheck: Recheck = () => null;
/** scheduler-wip-gate.ts 接线：on 且仍是首次准入、深度 ≥ 阈值时给等待原因 */
export function setWipGateClaimRecheck(fn: Recheck): void {
  recheck = fn;
}

/** settleIntent 认领事务里的重核：只看调度服务把作者首次开工意图 pending→submitted；挂池意图另由挂池步骤重核 */
export function wipGateClaim(db: Database, actor: string, move: { from: IntentStatus; to: IntentStatus }, intent: SchedulerIntent): string | null {
  if (actor !== "scheduler" || move.from !== "pending" || move.to !== "submitted" || !authorStart(intent) || isPoolIntent(intent)) return null;
  const task = getTask(db, intent.taskId);
  return task ? recheck(db, task) : null;
}
