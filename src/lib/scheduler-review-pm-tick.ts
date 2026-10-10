/**
 * 审查已回待 PM 处置提醒（dispatch-recovery-RVWAKE1）调度侧：自动开卡 tick 在合并待处置提醒之后跑一次（pmWakeTicks）。
 * 只读快照预筛（reviewPmCandidate + reviewPmDue），过了才经调度身份的 `ledger scheduler-autostart review-pm … record` 记账；
 * 台账回 due 且模式 on 才发。记录后再按只读连接重算：开关不再是 on、实例键变了（推了阶段 / 新 head / 新审查 / 换 PM）就不发陈旧动作。
 * 发送走 sendToPm（生产 = notifyProjectPm 带本轮存活检查），发出才写 sent；失败或回 false 不写，30 分钟后同一实例重试。
 * 租约丢了 → SchedulerStopped 照原路径传播；别的失败只进本轮 failed，一张卡出错不挡别的卡。tests/scheduler-review-pm-*.test.ts。
 */
import { listTasks } from "./ledger-store.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { reviewPmDue, reviewPmMode, type ReviewPmMode } from "./scheduler-review-pm-ledger.js";
import { reviewPmCandidate } from "./scheduler-review-pm-wait.js";
import { sendToPm, type SpecWaitEnv } from "./scheduler-spec-wait.js";

type Failed = { taskId: string; error: string }[];

async function reviewPmLedger(env: SpecWaitEnv, ...args: string[]): Promise<Record<string, unknown>> {
  const r = await env.ledger("ledger", "scheduler-autostart", "review-pm", ...args);
  if (r.code === "lease-lost") throw new SchedulerStopped(`ledger review-pm: ${String(r.error)}`);
  return r;
}

/** 一张卡一轮：预筛 → 记账 → （on 且 due）发前重核 → 发 → 记送达；返回本卡的失败说明 */
async function nudgeOne(env: SpecWaitEnv, project: string, taskId: string, mode: Exclude<ReviewPmMode, "off">): Promise<string | null> {
  const seen = reviewPmCandidate(env.db, taskId, env.now());
  if (!seen || !reviewPmDue(env.db, taskId, seen.key, mode, env.now())) return null;
  const rec = await reviewPmLedger(env, taskId, "record", seen.key, "--mode", mode, "--pm", seen.pm);
  if (rec.code === "conflict") return null; // 预读到写之间条件变了：下一轮按新状态重判
  if (rec.ok !== true) return `审查已回提醒记账失败：${String(rec.error ?? rec.code)}`;
  if (rec.due !== true || mode !== "on") return null;
  if (reviewPmMode(env.db, project) !== "on" || reviewPmCandidate(env.db, taskId, env.now())?.key !== seen.key) return null;
  let answer: unknown;
  try {
    answer = await sendToPm(env, project, seen.pm, String(rec.text));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `审查已回提醒发给 ${seen.pm} 失败：${(e as Error).message}`;
  }
  if (answer === false) return `审查已回提醒发给 ${seen.pm} 失败：发送端回 false`;
  const ack = await reviewPmLedger(env, taskId, "sent", String(rec.seq), "--mode", "on", "--pm", seen.pm);
  return ack.ok === true ? null : `审查已回提醒已发、记已发失败：${String(ack.error ?? ack.code)}`;
}

export async function reviewPmTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [];
  for (const project of [...env.svc.projects].sort()) {
    const mode = reviewPmMode(env.db, project);
    if (mode === "off") continue;
    for (const t of listTasks(env.db, project)) {
      if (t.stage !== "review") continue;
      try {
        const error = await nudgeOne(env, project, t.id, mode);
        if (error) failed.push({ taskId: t.id, error });
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        failed.push({ taskId: t.id, error: `审查已回提醒：${(e as Error).message}` });
      }
    }
  }
  return failed;
}
