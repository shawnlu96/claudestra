/**
 * RLOCK2 绑定到卡上的本机 agent 活动（LIFE1 的 recent 判定：回合在跑，或最近 recentMs 内有动静；读不到空闲时长时看窗口在不在）。
 * tick 判定与 `ledger scheduler-lock-yield` 写侧各读一次：写侧不信 tick 带来的活动，自己重读，事务里再按绑定与 ACP 心跳核一遍。
 * 不确定就不让：registry 读不了、结构坏（顶层 agents 不是对象 / 条目不是对象 / 条目规范化后对不上）一律 null。
 */
import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { cardWorkerIndex } from "./agent-lifecycle-store.js";
import { readActivity } from "./agent-supervisor-activity.js";
import { agentWindowsOrNull } from "./agent-windows.js";
import { normalizeRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import type { YieldAgent } from "./scheduler-lock-yield.js";
import { sessionJsonlPath } from "./session-source.js";
import { readJsonStateSync } from "./state-file.js";

/** taskId → 绑定的本机 agent；null = registry 读不了或结构坏（b 不判） */
export type AgentsOf = (db: Database, now: number, recentMs: number) => Promise<Map<string, YieldAgent[]> | null>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 整份 registry 可信才用：normalizeRegistryAgents 遇到脏条目会整体返回 []，那等于「谁都不在本机」，会误判空闲 */
export function registryAgents(path = REGISTRY_PATH): Map<string, RegistryAgent> | null {
  const reg = readJsonStateSync(path);
  if (reg.status !== "ok" || !isObj(reg.data)) return null;
  const raw = reg.data.agents;
  if (!isObj(raw) || Object.values(raw).some((v) => !isObj(v))) return null;
  const list = normalizeRegistryAgents(reg.data);
  if (list.length !== Object.keys(raw).length) return null;
  return new Map(list.map((a) => [a.name, a]));
}

async function idleOf(a: RegistryAgent, now: number): Promise<{ idleMs: number | null; turnActive: boolean }> {
  const rec = readActivity(a.name);
  if (rec && a.sessionId && rec.sessionId === a.sessionId) return { idleMs: now - Math.max(rec.updateAt, rec.turnAt), turnActive: rec.busy };
  const path = a.cwd && a.sessionId ? sessionJsonlPath(a.runtime, a.cwd, a.sessionId) : null;
  const mtime = path ? await stat(path).then((s) => s.mtimeMs, () => null) : null; // 没有会话文件：空闲时长未知，下面按窗口判
  return { idleMs: mtime === null ? null : now - mtime, turnActive: false };
}

/** registry 里没有的名字：不是本机登记的 agent；但 ACP 心跳文件说它在跑 / 刚动过，照样算有活动 */
function unregistered(name: string, now: number, recentMs: number): YieldAgent {
  const rec = readActivity(name);
  if (!rec) return { name, recent: false, lastAt: null };
  const last = Math.max(rec.updateAt, rec.turnAt);
  return { name, recent: rec.busy || now - last < recentMs, lastAt: last, sessionId: rec.sessionId };
}

/** 生产取法：worker 索引（登记 / 调度绑定 / tasks.agent）反查到卡 */
export const localAgents: AgentsOf = async (db, now, recentMs) => {
  const agents = registryAgents();
  if (!agents) return null;
  let windows: Promise<Set<string> | null> | undefined;
  const open = () => (windows ??= agentWindowsOrNull().then((w) => (w ? new Set(w.map((x) => x.name)) : null)));
  const out = new Map<string, YieldAgent[]>();
  for (const [name, w] of cardWorkerIndex(db)) {
    const a = agents.get(name);
    let fact = unregistered(name, now, recentMs);
    if (a) {
      const { idleMs, turnActive } = await idleOf(a, now);
      const win = idleMs === null && !turnActive ? await open() : null; // 只有空闲时长未知才看窗口
      const running = !!win?.has(name) || ((a.transport === "acp" || !win) && a.status === "active");
      fact = { name, recent: turnActive || (idleMs !== null ? idleMs < recentMs : running), lastAt: idleMs === null ? null : now - idleMs, sessionId: a.sessionId ?? null };
    }
    for (const id of new Set(w.links.map((l) => l.taskId).filter((t): t is string => !!t))) out.set(id, [...(out.get(id) ?? []), fact]);
  }
  return out;
};

/** 写事务里的最后一道：绑定和重读时一样、每个绑定 agent 的 ACP 心跳没在跑回合；不然返回原因（拒） */
export function agentsStillIdle(db: Database, taskId: string, fresh: readonly YieldAgent[]): string | null {
  const bound = new Set<string>();
  for (const [name, w] of cardWorkerIndex(db)) if (w.links.some((l) => l.taskId === taskId)) bound.add(name);
  const seen = new Set(fresh.map((a) => a.name));
  if (bound.size !== seen.size || [...bound].some((n) => !seen.has(n))) return "绑定的 agent 刚变";
  for (const a of fresh) {
    const rec = readActivity(a.name);
    if (rec?.busy && (!a.sessionId || rec.sessionId === a.sessionId)) return `绑定的 ${a.name} 刚开了回合`;
  }
  return null;
}
