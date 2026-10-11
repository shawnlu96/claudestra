/**
 * WIP 闸（dispatch-recovery-WIPGATE1）：项目合并队列达到阈值时，调度器先不开新卡，只做审查、修复、合并、部署；队列降下来下一轮自动恢复，
 * 不存闭闸状态、不落 hold、不取消意图、不消耗 arm。闸只拦「开新卡」= 首次自动准入：
 * - DAG 待开节点（scheduler-autostart-run.ts 选候选时判，ledger-autostart.ts claim 事务里重核）；
 * - 已建卡、从没开过工的 auto 卡的首次作者建会话 / 首次开工派单（scheduler-auto-tick.ts 一行接入 wipGateCard，含已存在的未发 pending 意图），
 *   spec 放置（scheduler-spec-resume.ts）；认领作者意图（scheduler-settle 认领事务）、挂新 write 单（ledger-scheduler-pool.ts）时再重核，见 scheduler-wip-gate-claim.ts。
 * 开没开过工看台账事实（neverStarted），不看 specRev：自动开卡 claim、start_node 建卡、执行者 / 作者绑定、派出过的作者单、挂池、写租约，有一样就是续做。
 * 手动 start_node 的卡因此一律放行；修复、审查、合并、收尾按节点放行。档位与深度见 scheduler-wip-gate-config.ts，观察记录见 scheduler-wip-gate-log.ts。
 */
import type { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { planScheduler } from "./scheduler-plan.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { authorStart, neverStarted, setWipGateClaimRecheck } from "./scheduler-wip-gate-claim.js";
import { wipGateConfig, wipGateDepth, wipGateHold, wipGateHoldText, type WipGateConfig } from "./scheduler-wip-gate-config.js";
import { wipGateObserve } from "./scheduler-wip-gate-log.js";

type WipGateEntry = "autostart" | "author" | "spec-place";

function decide(db: Database, project: string, taskId: string, entry: WipGateEntry, cfg: WipGateConfig): string | null {
  const depth = wipGateDepth(db, project);
  if (depth === null || depth < cfg.threshold) return null;
  wipGateObserve({ project, task: taskId, entry, depth, threshold: cfg.threshold, mode: cfg.mode });
  return cfg.mode === "on" ? wipGateHoldText(depth, cfg.threshold) : null;
}

/** DAG 待开节点（卡号是确定的候选卡号）：on 且拥堵返回等待原因；observe 只记日志；off 不读队列 */
export function wipGateNode(db: Database, project: string, taskId: string): string | null {
  const cfg = wipGateConfig(db, project);
  return cfg.mode === "off" ? null : decide(db, project, taskId, "autostart", cfg);
}

/**
 * auto tick 每张卡在驱动 / 计划之前：open 是卡上最新的未结意图。未发的 pending 作者意图按它判（保留原意图），没有未结意图按本轮计划判；
 * 已认领 / 不明的意图是在途效果，不拦。
 */
export function wipGateCard(db: Database, task: LedgerTask, open: SchedulerIntent | null, opts: SnapshotOpts): string | null {
  const cfg = wipGateConfig(db, task.project);
  if (cfg.mode === "off" || (open && open.status !== "pending") || !neverStarted(db, task)) return null;
  const work = open ?? planScheduler(autoSnapshot(db, task, opts));
  return "action" in work && authorStart(work) ? decide(db, task.project, task.id, "author", cfg) : null;
}

/** spec 卡交回自动后的放置：写放置 / 等待状态之前判 */
export function wipGateSpecPlace(db: Database, task: LedgerTask): string | null {
  const cfg = wipGateConfig(db, task.project);
  return cfg.mode === "off" || !neverStarted(db, task) ? null : decide(db, task.project, task.id, "spec-place", cfg);
}

/** 挂新 write 单前、认领作者首次开工意图时的重核：只在 on 且仍是首次准入时拦，不记日志 */
export const wipGateRecheck = (db: Database, task: LedgerTask): string | null => wipGateHold(db, task.project, () => neverStarted(db, task));
setWipGateClaimRecheck(wipGateRecheck);
