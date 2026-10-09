/**
 * 合并待 PM 处置提醒（dispatch-recovery-MQWAKE1）调度侧：自动开卡 tick 每轮紧跟缺规格 / 上线后提醒调一次（pmWakeTicks）。
 * 只读快照预筛（mergePmCandidate + mergePmDue），过了才经调度身份的 `ledger scheduler-autostart merge-pm … record` 记账；
 * 台账回 due 且模式 on 才发。发前再按只读连接重算一次：开关不再是 on、阻塞键或收件人变了（新请求 / 新验收 / 离开 merge / 换 PM）就不发陈旧动作；
 * 发送走 sendToPm（生产 = notifyProjectPm 带本轮 stillActive：停服 / 失租什么都不发）。发出才写 sent 确认；发送失败或回 false 不写，
 * 30 分钟后按同一实例重试。租约丢了 → SchedulerStopped 照原路径传播；别的失败只进本轮 failed，不盖开卡等原有错误。
 * tests/scheduler-merge-pm-wait.test.ts。
 */
import { listTasks } from "./ledger-store.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { mergePmDue, mergePmMode } from "./scheduler-merge-pm-ledger.js";
import { mergePmCandidate, mergePmTarget } from "./scheduler-merge-pm-wait.js";
import { postVerifyTick } from "./scheduler-post-verify.js";
import { sendToPm, specWaitTick, type SpecWaitEnv } from "./scheduler-spec-wait.js";

type Failed = { taskId: string; error: string }[];

async function cli(env: SpecWaitEnv, ...args: string[]): Promise<Record<string, unknown>> {
  const r = await env.ledger("ledger", "scheduler-autostart", "merge-pm", ...args);
  if (r.code === "lease-lost") throw new SchedulerStopped(`ledger merge-pm: ${String(r.error)}`);
  return r;
}

async function remind(env: SpecWaitEnv, project: string, taskId: string, mode: "on" | "observe", failed: Failed): Promise<void> {
  const c = mergePmCandidate(env.db, taskId, env.now()), pm = mergePmTarget(env.db, taskId);
  if (!c || !pm || !mergePmDue(env.db, taskId, c.key, mode, env.now())) return;
  const rec = await cli(env, taskId, "record", c.key, "--mode", mode, "--pm", pm);
  if (rec.code === "conflict") return; // 读快照到写之间条件变了：下一轮按新状态重判
  if (rec.ok !== true) return void failed.push({ taskId, error: `合并待处置提醒记账失败：${String(rec.error ?? rec.code)}` });
  if (rec.due !== true || mode !== "on") return;
  const now = mergePmCandidate(env.db, taskId, env.now());
  // 记录后状态变了（开关改 observe / off、新请求 / 新验收 / 离开 merge、换 PM）：不发陈旧动作
  if (mergePmMode(env.db, project) !== "on" || now?.key !== c.key || mergePmTarget(env.db, taskId) !== pm) return;
  try {
    if ((await sendToPm(env, project, pm, String(rec.text))) as unknown === false) throw new Error("发送端回 false");
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return void failed.push({ taskId, error: `合并待处置提醒发给 ${pm} 失败：${(e as Error).message}` });
  }
  const ack = await cli(env, taskId, "sent", String(rec.seq), "--mode", "on", "--pm", pm);
  if (ack.ok !== true) failed.push({ taskId, error: `合并待处置提醒已发、记已发失败：${String(ack.error ?? ack.code)}` });
}

async function mergePmTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [];
  try {
    for (const project of [...env.svc.projects].sort()) {
      const mode = mergePmMode(env.db, project);
      if (mode === "off") continue;
      for (const t of listTasks(env.db, project)) if (t.stage === "merge") await remind(env, project, t.id, mode, failed);
    }
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "merge-pm", error: (e as Error).message });
  }
  return failed;
}

/** 自动开卡 tick 里按序跑的 PM 提醒：缺规格、上线后、合并待处置 */
export const pmWakeTicks = [specWaitTick, postVerifyTick, mergePmTick] as const;
