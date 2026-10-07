/**
 * RLOCK2 的 tick 一步（scheduler-pass.ts 每轮在 auto tick 之前调一次）：只读句柄上判定，所有写入经 `ledger scheduler-lock-yield` 子命令。
 * 本机 agent 活动按 LIFE1 的 recent 判定（回合在跑，或最近 recentTurnMin 内有动静；读不到空闲时长时看窗口在不在）。
 * 让过锁的卡恢复推进却拿不回锁：记一次、通知 PM 一次（通知没送达就下轮重发），不抢回。off / 策略读坏：什么都不做。
 */
import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { DEFAULT_LIFECYCLE } from "./agent-lifecycle-config.js";
import { cardWorkerIndex } from "./agent-lifecycle-store.js";
import { readActivity } from "./agent-supervisor-activity.js";
import { agentWindowsOrNull } from "./agent-windows.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { normalizeRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { contendKey, LOCK_YIELD_KEY, observeActionKey, planLockYield, yieldDedupKey, type YieldAgent, type YieldCandidate } from "./scheduler-lock-yield.js";
import { readYieldFacts, releasedPending, resumedAfter } from "./scheduler-lock-yield-read.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { sessionJsonlPath } from "./session-source.js";
import { readJsonStateSync } from "./state-file.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type NotifyPm = (task: LedgerTask, text: string) => Promise<void>;
/** taskId → 绑定的本机 agent；null = registry 读不了（b 不判） */
type AgentsOf = (db: Database, now: number, recentMs: number) => Promise<Map<string, YieldAgent[]> | null>;
export interface LockYieldIo { agents?: AgentsOf; now?: () => number }

async function idleOf(a: RegistryAgent, now: number): Promise<{ idleMs: number | null; turnActive: boolean }> {
  const rec = readActivity(a.name);
  if (rec && a.sessionId && rec.sessionId === a.sessionId) return { idleMs: now - Math.max(rec.updateAt, rec.turnAt), turnActive: rec.busy };
  const path = a.cwd && a.sessionId ? sessionJsonlPath(a.runtime, a.cwd, a.sessionId) : null;
  const mtime = path ? await stat(path).then((s) => s.mtimeMs, () => null) : null; // 没有会话文件：空闲时长未知，下面按窗口判
  return { idleMs: mtime === null ? null : now - mtime, turnActive: false };
}

/** 生产取法：worker 索引（登记 / 调度绑定 / tasks.agent）反查到卡，registry 里没有的 agent 不是本机的（不活动） */
const localAgents: AgentsOf = async (db, now, recentMs) => {
  const reg = readJsonStateSync(REGISTRY_PATH);
  if (reg.status !== "ok") return null;
  const agents = new Map(normalizeRegistryAgents(reg.data).map((a) => [a.name, a]));
  const windows = await agentWindowsOrNull(), open = new Set(windows?.map((w) => w.name) ?? []);
  const out = new Map<string, YieldAgent[]>();
  for (const [name, w] of cardWorkerIndex(db)) {
    const a = agents.get(name);
    let fact: YieldAgent = { name, recent: false, lastAt: null };
    if (a) {
      const { idleMs, turnActive } = await idleOf(a, now);
      const running = open.has(name) || ((a.transport === "acp" || !windows) && a.status === "active");
      fact = { name, recent: turnActive || (idleMs !== null ? idleMs < recentMs : running), lastAt: idleMs === null ? null : now - idleMs };
    }
    for (const id of new Set(w.links.map((l) => l.taskId).filter((t): t is string => !!t))) out.set(id, [...(out.get(id) ?? []), fact]);
  }
  return out;
};

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
  now: number, manager: Manager): Promise<{ taskId: string; error: string }[]> {
  const facts = readYieldFacts(db, project);
  if (!facts.held.length && !facts.unknown.length) return [];
  const agents = await agentsOf(); // 有锁才读本机 agent 活动（registry / 窗口）
  const plan = planLockYield(facts, (id) => (agents ? agents.get(id) ?? [] : null), now);
  const failed: { taskId: string; error: string }[] = [];
  for (const c of plan.candidates) {
    if (done(db, project, mode, c)) continue;
    const wire = { v: 1, phase: "yield", basis: c.basis, since: c.since, resources: c.resources, agents: agents ? agents.get(c.taskId) ?? [] : null };
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
  policy: RecoveryPolicyPort = recoveryPolicy, io: LockYieldIo = {}): Promise<{ taskId: string; error: string }[]> {
  const now = (io.now ?? Date.now)(), failed: { taskId: string; error: string }[] = [];
  const recentMs = (config.lifecycle?.recentTurnMin ?? DEFAULT_LIFECYCLE.recentTurnMin) * 60_000;
  let agents: Promise<Map<string, YieldAgent[]> | null> | undefined;
  const agentsOf = () => (agents ??= (io.agents ?? localAgents)(db, now, recentMs));
  for (const project of Object.keys(config.projects)) {
    const p = policy(project, LOCK_YIELD_KEY);
    if (p.source === "error" || p.mode === "off") continue;
    try {
      failed.push(...await yieldProject(db, project, p.mode, agentsOf, now, manager));
      await contendProject(db, project, manager, notifyPm);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ taskId: `lock-yield ${project}`, error: (e as Error).message.slice(0, 300) });
    }
  }
  return failed;
}
