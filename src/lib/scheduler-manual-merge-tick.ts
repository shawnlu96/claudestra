/**
 * manual 卡代排人工合并（merge-arch-MANAUTOQ1）调度侧：自动开卡 tick 的 pmWakeTicks 里排在审查已回提醒（reviewPmTick）之前。
 * 恢复键 manualMergeAuto：off 什么都不做（逐字回到现状）；observe / on 只读快照预筛（manualMergeCandidate），过了才经调度身份的
 * `ledger scheduler-autostart manual-merge <卡> request <指纹> --mode …` 在事务里重核并写；conflict 下一轮重判。推成功后卡离开 review，
 * RVWAKE1 自然不再提醒；不满足条件的卡照旧由 RVWAKE1 提醒。合并本身仍由人工合并队列的 claim / controller 执行。
 * 租约丢了 → SchedulerStopped 照原路径传播；别的失败只进本轮 failed，一张卡出错不挡别的卡。
 */
import { getEventByDedup, listTasks } from "./ledger-store.js";
import { observeDedupKey } from "./recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { manualMergeAutoMode, manualMergeCandidate, MANUAL_MERGE_AUTO_KEY, observeActionKey } from "./scheduler-manual-merge-ready.js";
import type { SpecWaitEnv } from "./scheduler-spec-wait.js";

type Failed = { taskId: string; error: string }[];

async function autoOne(env: SpecWaitEnv, taskId: string, mode: "on" | "observe"): Promise<string | null> {
  const c = manualMergeCandidate(env.db, taskId, env.now());
  if (!c) return null;
  // observe：同一指纹的样本已有就不再起子命令
  if (mode === "observe" && getEventByDedup(env.db, observeDedupKey({ project: c.project, mechanism: MANUAL_MERGE_AUTO_KEY, target: taskId,
    actionKey: observeActionKey(c.fingerprint) }))) return null;
  const r = await env.ledger("ledger", "scheduler-autostart", "manual-merge", taskId, "request", c.fingerprint, "--mode", mode);
  if (r.code === "lease-lost") throw new SchedulerStopped(`ledger manual-merge: ${String(r.error)}`);
  if (r.code === "conflict") return null; // 预读到写之间条件变了：下一轮按新状态重判
  return r.ok === true ? null : `代排人工合并失败：${String(r.error ?? r.code)}`;
}

export async function manualMergeAutoTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [];
  for (const project of [...env.svc.projects].sort()) {
    const mode = manualMergeAutoMode(project);
    if (mode === "off") continue;
    for (const t of (env.reads?.tasks(project) ?? listTasks(env.db, project))) {
      if (t.stage !== "review") continue;
      try {
        const error = await autoOne(env, t.id, mode);
        if (error) failed.push({ taskId: t.id, error });
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        failed.push({ taskId: t.id, error: `代排人工合并：${(e as Error).message}` });
      }
    }
  }
  return failed;
}
