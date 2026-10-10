/**
 * RLOCK2 的 tick 一步（scheduler-pass.ts 每轮在 auto tick 之前调一次）：只读句柄上判定，所有写入经 `ledger scheduler-lock-yield` 子命令。
 * 本机 agent 活动按 LIFE1 的 recent 判定（scheduler-lock-yield-agents.ts）；写侧不信这里读到的活动，自己重读（带 recentMs 过去）。
 * 模式按 lockYieldPolicy（只认 keys.lockYield，项目级 on 不带上它，缺省 observe）。
 * 让过锁的卡恢复推进却拿不回锁：记一次、通知 PM 一次（通知没送达就下轮重发），不抢回。off / 策略读坏：什么都不做。
 */
import type { Database } from "bun:sqlite";
import { DEFAULT_LIFECYCLE } from "./agent-lifecycle-config.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { observeDedupKey, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { contendKey, LOCK_YIELD_KEY, observeActionKey, planLockYield, yieldDedupKey, type YieldAgent, type YieldCandidate } from "./scheduler-lock-yield.js";
import { localAgents, type AgentsOf } from "./scheduler-lock-yield-agents.js";
import { lockYieldPolicy } from "./scheduler-lock-yield-policy.js";
import { readYieldFacts, releasedPending, resumedAfter } from "./scheduler-lock-yield-read.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type NotifyPm = (task: LedgerTask, text: string) => Promise<void>;
export interface LockYieldIo { agents?: AgentsOf; now?: () => number }

const lost = (what: string, e: unknown): void => {
  if (e instanceof SchedulerStopped) throw e;
  console.error(`⚠️ [lock-yield] ${what}：${(e as Error).message}`);
};

/** 已经记过的不再调子命令：observe 看观察去重键，on 看让锁去重键 */
function done(db: Database, project: string, mode: "on" | "observe", c: YieldCandidate): boolean {
  const key = mode === "on" ? yieldDedupKey(c.taskId, c.since)
    : observeDedupKey({ project, mechanism: LOCK_YIELD_KEY, target: c.taskId, actionKey: observeActionKey(c.since) });
  return !!getEventByDedup(db, key);
}

async function yieldProject(db: Database, project: string, mode: "on" | "observe", agentsOf: () => Promise<Map<string, YieldAgent[]> | null>,
  now: number, recentMs: number, manager: Manager): Promise<{ taskId: string; error: string }[]> {
  const facts = readYieldFacts(db, project);
  if (!facts.held.length && !facts.unknown.length) return [];
  const agents = await agentsOf(); // 有锁才读本机 agent 活动（registry / 窗口）
  const plan = planLockYield(facts, (id) => (agents ? agents.get(id) ?? [] : null), now);
  const failed: { taskId: string; error: string }[] = [];
  for (const c of plan.candidates) {
    if (done(db, project, mode, c)) continue;
    const wire = { v: 1, phase: "yield", basis: c.basis, since: c.since, resources: c.resources, recentMs };
    const r = await manager("ledger", "scheduler-lock-yield", c.taskId, "--data", JSON.stringify(wire));
    if (r.ok === true) console.log(`[lock-yield] ${mode === "on" ? "让锁" : "本可让锁（observe）"} ${c.taskId}：${c.resources.length} 个`);
    else if (r.code === "conflict") console.error(`[lock-yield] ${c.taskId} 重核不让：${String(r.error)}`);
    else failed.push({ taskId: `lock-yield ${c.taskId}`, error: String(r.error ?? "未知错误").slice(0, 300) });
  }
  return failed;
}

/** 让过锁的卡：恢复后拿不回锁 → 记一次 → 通知 PM → 标已送达；任一步没成，下轮从没成的那步重来 */
async function contendProject(db: Database, project: string, manager: Manager, notifyPm: NotifyPm): Promise<void> {
  for (const r of releasedPending(db, project)) {
    const task = getTask(db, r.taskId);
    if (!task) continue;
    const step = (phase: string) => manager("ledger", "scheduler-lock-yield", r.taskId, "--data", JSON.stringify({ v: 1, phase, releaseSeq: r.seq }));
    let text = r.contended ? getEventByDedup(db, contendKey(r.seq))?.text ?? null : null;
    if (!r.contended) {
      if (!resumedAfter(db, r.taskId, r.seq)) continue;
      const w = await step("contend");
      if (w.ok !== true) { if (w.code !== "conflict") console.error(`⚠️ [lock-yield] ${r.taskId} 拿不回锁未记账：${String(w.error)}`); continue; }
      text = String(w.text);
    }
    if (!text) continue;
    try { await notifyPm(task, text); } catch (e) { lost(`${r.taskId} 拿不回锁的通知没送到（台账已记，下轮重发）`, e); continue; }
    const sent = await step("contend-sent");
    if (sent.ok !== true) console.error(`⚠️ [lock-yield] ${r.taskId} 已通知 PM 但送达标记未记账，下轮可能重发：${String(sent.error)}`);
  }
}

/** 每轮一次：各项目按策略键 lockYield 判；失败按卡报给 pass，不抛（SchedulerStopped 除外） */
export async function lockYieldStep(db: Database, config: SchedulerConfig, manager: Manager, notifyPm: NotifyPm,
  policy: RecoveryPolicyPort = lockYieldPolicy, io: LockYieldIo = {}): Promise<{ taskId: string; error: string }[]> {
  const now = (io.now ?? Date.now)(), failed: { taskId: string; error: string }[] = [];
  const recentMs = (config.lifecycle?.recentTurnMin ?? DEFAULT_LIFECYCLE.recentTurnMin) * 60_000;
  let agents: Promise<Map<string, YieldAgent[]> | null> | undefined;
  const agentsOf = () => (agents ??= (io.agents ?? localAgents)(db, now, recentMs));
  for (const project of Object.keys(config.projects)) {
    const p = policy(project, LOCK_YIELD_KEY);
    if (p.source === "error" || p.mode === "off") continue;
    try {
      failed.push(...await yieldProject(db, project, p.mode, agentsOf, now, recentMs, manager));
      await contendProject(db, project, manager, notifyPm);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ taskId: `lock-yield ${project}`, error: (e as Error).message.slice(0, 300) });
    }
  }
  return failed;
}
