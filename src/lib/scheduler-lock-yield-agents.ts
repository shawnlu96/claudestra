/**
 * RLOCK2 绑定到卡上的本机 agent 活动（LIFE1 的 recent 判定：回合在跑，或最近 recentMs 内有动静；读不到空闲时长时看窗口在不在）。
 * tick 判定与 `ledger scheduler-lock-yield` 写侧各读一次：写侧不信 tick 带来的活动，自己重读，事务里再按绑定与 ACP 心跳核一遍。
 * 不确定就不让：registry 读不了、结构坏（顶层 agents 不是对象 / 条目不是对象 / 条目规范化后对不上）一律 null；
 * 某个绑定 agent 的 ACP 心跳在但读坏、会话文件 stat 出错，记 unknown（那张卡 b 不判，不退回旧 mtime）。
 * 每个 agent 带一份签名（sig）：写事务里当场重读、对不上就拒，挡住「重读之后、事务之前」活动变了的窗口。
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { cardWorkerIndex } from "./agent-lifecycle-store.js";
import { activityPath, readActivity, safeName, type ActivityRecord } from "./agent-supervisor-activity.js";
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

/** 一个 agent 此刻的活动原料：ACP 心跳（missing / ok / bad = 在但读坏或读失败）+ 会话文件 mtime（null = 没有；"bad" = stat 出错）。全同步，事务里能原样再读一遍 */
interface Probe { act: "missing" | "bad" | ActivityRecord; mtime: number | null | "bad" }

function probe(name: string, a: RegistryAgent | undefined): Probe {
  const rec = readActivity(name);
  const act = rec ?? (safeName(name) && readJsonStateSync(activityPath(name)).status === "missing" ? "missing" : "bad");
  if (!a || (act !== "missing" && act !== "bad" && a.sessionId && act.sessionId === a.sessionId)) return { act, mtime: null };
  const path = a.cwd && a.sessionId ? sessionJsonlPath(a.runtime, a.cwd, a.sessionId) : null;
  if (!path) return { act, mtime: null };
  try { return { act, mtime: statSync(path).mtimeMs }; } catch (e) { return { act, mtime: (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "bad" }; }
}

/** 快照签名：registry 条目里影响判定的字段 + 原料；写事务里重算一遍，任何一处不同（换会话、刚跑完短回合、心跳变坏…）就拒旧请求 */
const signOf = (a: RegistryAgent | undefined, p: Probe): string =>
  JSON.stringify([a ? [a.sessionId ?? null, a.status ?? null, a.transport ?? null, a.runtime ?? null, a.cwd ?? null] : null, p.act, p.mtime]);

/** 心跳读坏 / 会话文件 stat 出错：空闲与否不可判定（不能退回旧 mtime），不让 */
function unknownOf(p: Probe): string | undefined {
  if (p.act === "bad") return "ACP 心跳文件读坏";
  if (p.mtime === "bad") return "会话文件读不了";
  return undefined;
}

/** registry 里没有的名字：不是本机登记的 agent；但 ACP 心跳文件说它在跑 / 刚动过，照样算有活动 */
function unregistered(name: string, p: Probe, now: number, recentMs: number): YieldAgent {
  const unknown = unknownOf(p), sig = signOf(undefined, p);
  if (p.act === "missing" || p.act === "bad") return { name, recent: false, lastAt: null, sig, ...(unknown ? { unknown } : {}) };
  const last = Math.max(p.act.updateAt, p.act.turnAt);
  return { name, recent: p.act.busy || now - last < recentMs, lastAt: last, sessionId: p.act.sessionId, sig };
}

/** 生产取法：worker 索引（登记 / 调度绑定 / tasks.agent）反查到卡 */
export const localAgents: AgentsOf = async (db, now, recentMs) => {
  const agents = registryAgents();
  if (!agents) return null;
  let windows: Promise<Set<string> | null> | undefined;
  const open = () => (windows ??= agentWindowsOrNull().then((w) => (w ? new Set(w.map((x) => x.name)) : null)));
  const out = new Map<string, YieldAgent[]>();
  for (const [name, w] of cardWorkerIndex(db)) {
    const a = agents.get(name), p = probe(name, a);
    let fact = unregistered(name, p, now, recentMs);
    if (a) {
      const rec = p.act !== "missing" && p.act !== "bad" && a.sessionId && p.act.sessionId === a.sessionId ? p.act : null;
      const idleMs = rec ? now - Math.max(rec.updateAt, rec.turnAt) : typeof p.mtime === "number" ? now - p.mtime : null;
      const turnActive = !!rec?.busy;
      const win = idleMs === null && !turnActive ? await open() : null; // 只有空闲时长未知才看窗口
      const running = !!win?.has(name) || ((a.transport === "acp" || !win) && a.status === "active");
      const unknown = unknownOf(p);
      fact = { name, recent: turnActive || (idleMs !== null ? idleMs < recentMs : running), lastAt: idleMs === null ? null : now - idleMs,
        sessionId: a.sessionId ?? null, sig: signOf(a, p), ...(unknown ? { unknown } : {}) };
    }
    for (const id of new Set(w.links.map((l) => l.taskId).filter((t): t is string => !!t))) out.set(id, [...(out.get(id) ?? []), fact]);
  }
  return out;
};

/**
 * 写事务里的最后一道：绑定和重读时一样；每个绑定 agent 的 registry 条目 + ACP 心跳 + 会话文件 mtime 当场再读一遍，签名要和重读时一字不差
 * （同会话刚跑完短回合、换了会话、心跳变坏都会变）；任何会话的心跳在跑回合也拒。不然返回原因（拒，下轮按新事实重算）。
 */
export function agentsStillIdle(db: Database, taskId: string, fresh: readonly YieldAgent[]): string | null {
  const bound = new Set<string>();
  for (const [name, w] of cardWorkerIndex(db)) if (w.links.some((l) => l.taskId === taskId)) bound.add(name);
  const seen = new Set(fresh.map((a) => a.name));
  if (bound.size !== seen.size || [...bound].some((n) => !seen.has(n))) return "绑定的 agent 刚变";
  const reg = registryAgents();
  if (!reg) return "本机 agent 活动读不了（registry）";
  for (const a of fresh) {
    const r = reg.get(a.name), p = probe(a.name, r);
    if (p.act !== "missing" && p.act !== "bad" && p.act.busy) return `绑定的 ${a.name} 刚开了回合`;
    if (unknownOf(p)) return `本机 agent 活动读不了（${a.name} ${unknownOf(p)}）`;
    if (!a.sig || signOf(r, p) !== a.sig) return `绑定的 ${a.name} 活动刚变（会话 / 心跳 / 会话文件），下轮重算`;
  }
  return null;
}
