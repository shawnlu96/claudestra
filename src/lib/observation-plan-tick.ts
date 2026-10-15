/**
 * 观察期到期核对的调度侧（agents-PMAUTO1）：自动开卡 tick 每轮跟在 PM 提醒后面跑一次（pmWakeTicks）。按登记文件的只读快照预筛出
 * 到期 / 停在半路 / 通知还没送达的登记，逐条经调度身份的 `ledger observation-due` 核；核对、切模式、记 note 都在那条命令里。
 * 这里只负责把它返回的那一条发给 PM 并记已送：交 PM 判断的一条只推一次（没送达的下一轮原文重发，不重核），转正成功的是一行摘要。
 * autoMode off 的项目整段跳过，不读、不调、不发。tests/observation-plan-tick.test.ts。
 */
import { autoMode, OBSERVATION_PLANS_PATH, readPlans, type AutoMode, type ObservationPlan } from "./observation-plan.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { sendToPm, type SpecWaitEnv } from "./scheduler-spec-wait.js";

type Failed = { taskId: string; error: string }[];

/** 这条登记这一轮要不要调台账（纯预筛；真正的判定在锁里重做）。 */
function observationPending(p: ObservationPlan, mode: AutoMode, now: number): boolean {
  if (p.status === "judged") return !p.judge?.sentAt;
  if (p.status === "promoted") return !p.digestSentAt;
  if (p.status !== "active") return false;
  if (p.receipt?.phase === "prepared" || p.receipt?.phase === "published") return true;
  return mode !== "off" && now >= p.dueAt && !(mode === "observe" && p.dryRun);
}

async function one(env: SpecWaitEnv, p: ObservationPlan, failed: Failed): Promise<void> {
  const rec = await env.ledger("ledger", "observation-due", p.taskId, p.id);
  if (rec.code === "lease-lost") throw new SchedulerStopped(`ledger observation-due: ${String(rec.error)}`);
  if (rec.ok !== true) return void failed.push({ taskId: p.taskId, error: `观察期登记 ${p.id} 核对失败：${String(rec.error ?? rec.code)}` });
  if (rec.outcome !== "judge" && rec.outcome !== "promoted" && rec.outcome !== "extended") return;
  try {
    if (!p.authorization && rec.outcome !== "extended" && (await sendToPm(env, p.project, String(rec.to ?? ""), String(rec.text))) as unknown === false) throw new Error("发送端回 false");
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return void failed.push({ taskId: p.taskId, error: `观察期登记 ${p.id} 的结果没发出去，下一轮重发：${(e as Error).message}` });
  }
  const ack = await env.ledger("ledger", "observation-due", p.taskId, p.id, "--sent");
  if (ack.code === "lease-lost") throw new SchedulerStopped(`ledger observation-due: ${String(ack.error)}`);
  if (ack.ok !== true) failed.push({ taskId: p.taskId, error: `观察期登记 ${p.id} 的结果已发、记已送失败：${String(ack.error ?? ack.code)}` });
}

export const observationTickAt = (path: string) => async (env: SpecWaitEnv): Promise<Failed> => {
  const failed: Failed = [];
  try {
    const modes = new Map(env.svc.projects.map((project) => [project, autoMode(env.db, project)] as const));
    if (![...modes.values()].some((m) => m !== "off")) return failed;
    for (const p of readPlans(path).plans) {
      const mode = modes.get(p.project);
      if (mode && mode !== "off" && observationPending(p, mode, env.now())) await one(env, p, failed);
    }
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "observation-plan", error: (e as Error).message });
  }
  return failed;
};

export const observationTick = observationTickAt(OBSERVATION_PLANS_PATH);
