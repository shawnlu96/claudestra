/**
 * runRemove's lifecycle branch: the scheduler's automatic retire (agent-lifecycle-run.ts collect) carries the plan's session, card
 * and last activity (LifecycleRemoveGuard). Under the agent's restart lock (the existing per-target lock) and the command's manager
 * write lock, this re-reads the registry entry, the windows to close (by tmux id) and a fresh lifecycle plan; anything changed,
 * unreadable or no longer due refuses and is left for the next pass. Windows, archive and the registry write-back only ever touch
 * the generation that was checked, never a same-name successor. A plain `manager remove` (person / PM) keeps runRemove's semantics.
 * A guard carrying sessionOnly (SessionRemoveGuard: cron's temp agents, which no card links and no plan lists) takes the same locks
 * and the same checked-generation remove, but re-checks only the entry's session; the plan is not read (tests/agent-remove-guard-session.test.ts).
 */
import { readFileSync } from "node:fs";
import { LIFECYCLE_GUARD_FLAG, type LifecycleRemoveGuard, type SessionRemoveGuard } from "../lib/agent-lifecycle-run.js";
import type { Plan } from "../lib/agent-lifecycle.js";
import { lifecycleSnapshot } from "../lib/agent-lifecycle-deps.js";
import { parseLifecycle, type LifecyclePolicy } from "../lib/agent-lifecycle-config.js";
import { removeAgentSettings } from "../lib/agent-settings.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { isPendingLive, newPending } from "../lib/pending-ops.js";
import { REGISTRY_PATH, saveRegistry, type AgentInfo, type Registry } from "./core.js";
import { channelFailureText, type OpsDeps } from "./ops-deps.js";
import { tryLockRestart, unlockRestart } from "./restart-lock.js";

export interface LifecycleRemoveFacts {
  /** take the agent's restart lock for the whole remove; null = a live restart holds it */
  lock(name: string): (() => void) | null;
  /** a fresh plan under the guard's policy and when its facts were read; throws when a source cannot be read */
  replan(policy: LifecyclePolicy): Promise<{ now: number; plan: Plan }>;
  /** registry write-back: mutate returns a reason to write nothing; the write compares against the bytes it read */
  commit(mutate: (reg: Registry) => string | null): Promise<string | null>;
  dropSettings(name: string): void;
}
/** guard as the flag's raw JSON is parsed inside the refusal net: a malformed one refuses rather than crashing the command */
export interface LifecycleRemove { guard: LifecycleRemoveGuard | SessionRemoveGuard | string; facts: LifecycleRemoveFacts }
type Checked<G = LifecycleRemoveGuard | SessionRemoveGuard> = { guard: G; facts: LifecycleRemoveFacts };

const ROLES = ["author", "reviewer", "stock"];

/** The guard flag's JSON; anything malformed throws (removeLifecycle refuses instead of falling back to a remove by name). */
export function parseLifecycleGuard(raw: string): LifecycleRemoveGuard {
  const v = JSON.parse(raw) as Partial<LifecycleRemoveGuard>;
  const nullable = (x: unknown, t: string) => x === null || typeof x === t;
  if (!v || !nullable(v.sessionId, "string") || !nullable(v.taskId, "string") || !ROLES.includes(String(v.role)) || typeof v.rule !== "string"
    || !nullable(v.activeAt, "number") || !v.policy || typeof v.policy !== "object") throw new Error(`${LIFECYCLE_GUARD_FLAG} 格式不对`);
  return { sessionId: v.sessionId!, taskId: v.taskId!, role: v.role!, rule: v.rule, activeAt: v.activeAt!, policy: { ...parseLifecycle(v.policy), mode: "on" } };
}

/** The flag's JSON in either shape. A guard that has the sessionOnly field must name a session; without the field it is the plan guard. */
function parseRemoveGuard(raw: string): LifecycleRemoveGuard | SessionRemoveGuard {
  const v = JSON.parse(raw) as Partial<SessionRemoveGuard> | null;
  if (!v || typeof v !== "object" || !("sessionOnly" in v)) return parseLifecycleGuard(raw);
  if (v.sessionOnly !== true || typeof v.sessionId !== "string" || !v.sessionId) throw new Error(`${LIFECYCLE_GUARD_FLAG} 只核会话的守卫必须带预期 sessionId`);
  return { sessionOnly: true, sessionId: v.sessionId };
}

const same = (a: AgentInfo | undefined, b: AgentInfo): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);

/** The entry itself: the planned session, nothing half done, one owner of the name. */
function entryProblem(reg: Registry, name: string, info: AgentInfo, g: LifecycleRemoveGuard): string | null {
  if (info.pending) return `条目带未完成的 ${info.pending.op}`;
  if (!g.sessionId || info.sessionId !== g.sessionId) return `现在的会话 ${info.sessionId ?? "?"} 不是计划里的 ${g.sessionId ?? "?"}`;
  if (Object.keys(reg.agents).some((k) => k !== name && k.toLowerCase() === name.toLowerCase())) return "registry 有大小写变体，归属不明";
  return null;
}

/**
 * The session-only guard's entry check: the expected session, no operation running on the entry (a dead leftover is finished here,
 * as a plain remove does), one owner of the name. `changed` marks the one refusal that means "another session holds the name now".
 */
function sessionEntryProblem(reg: Registry, name: string, info: AgentInfo, g: SessionRemoveGuard, deps: OpsDeps): { why: string; changed?: true } | null {
  if (!g.sessionId) return { why: "守卫没带预期 sessionId" };
  if (info.sessionId !== g.sessionId) return { why: `现在的会话 ${info.sessionId ?? "?"} 不是预期的 ${g.sessionId}`, changed: true };
  if (info.pending && isPendingLive(info.pending, deps.now(), deps.alive)) return { why: `条目正在 ${info.pending.op}（pid ${info.pending.pid}）` };
  if (Object.keys(reg.agents).some((k) => k !== name && k.toLowerCase() === name.toLowerCase())) return { why: "registry 有大小写变体，归属不明" };
  return null;
}

/** The plan's protections read again: still due for the same session and card, and no activity since the plan. */
async function planProblem(name: string, o: Checked<LifecycleRemoveGuard>): Promise<string | null> {
  const g = o.guard, { now, plan } = await o.facts.replan(g.policy);
  const fresh = [...plan.actions, ...plan.memory].find((x) => x.agent === name);
  if (!fresh) {
    const why = plan.kept.find((k) => k.agent === name)?.reason ?? (plan.frozen.some((f) => f.agent === name) ? "卡已冻结" : "按现在的事实已不该收");
    return `重核计划不收：${why}`;
  }
  if ((fresh.sessionId ?? null) !== g.sessionId) return `重核时会话是 ${fresh.sessionId ?? "?"}，不是计划里的 ${g.sessionId}`;
  if (fresh.taskId !== g.taskId || fresh.role !== g.role) return `卡归属变了（${g.taskId ?? "-"}/${g.role} → ${fresh.taskId ?? "-"}/${fresh.role}）`;
  const at = fresh.idleMs === null ? null : now - fresh.idleMs;
  if (g.activeAt === null ? at !== null : at === null) return "会话活动读数和计划时不一致（读不到或新出现），核不了有没有新回合";
  if (at !== null && g.activeAt !== null && at > g.activeAt + 1) return `计划之后有新活动（${new Date(at).toISOString()}），新回合不收`;
  return null;
}

async function removeChecked(name: string, deps: OpsDeps, o: Checked, refuse: (why: string) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const reg = await deps.loadRegistry();
  const info = reg.agents[name];
  const ids = await deps.windowIds(name);
  if (!info) return ids.length ? refuse(`registry 没有条目却有同名窗口 ${ids.join(",")}（新的一代？）`) : { ok: false, agent: name, error: `${name} 不存在` };
  const g = o.guard;
  if ("sessionOnly" in g) {
    const bad = sessionEntryProblem(reg, name, info, g, deps);
    // seenSession: the caller tells "another session holds the name" (never stop it) from a refusal it may retry
    if (bad) return { ...refuse(bad.why), ...(bad.changed ? { seenSession: info.sessionId ?? null } : {}) };
  } else {
    const why = entryProblem(reg, name, info, g) ?? await planProblem(name, { guard: g, facts: o.facts });
    if (why) return refuse(why);
  }
  // the objects about to be closed are the ones just checked: same entry bytes, same window ids
  if (!same((await deps.loadRegistry()).agents[name], info) || JSON.stringify(await deps.windowIds(name)) !== JSON.stringify(ids)) {
    return refuse("重核期间条目或窗口变了");
  }
  for (const id of ids) await deps.killWindowId(id);
  await deps.archive(name, info);
  if (info.channelId) {
    const r = await deps.deleteChannel(info.channelId);
    if (typeof r === "object") {
      const kept = await o.facts.commit((fresh) => {
        if (!same(fresh.agents[name], info)) return "条目已换代，不动新记录";
        Object.assign(fresh.agents[name], { status: "stopped", pending: { ...newPending("kill", {}, deps.now()), pid: 0, left: ["channel"] } });
        return null;
      });
      return { ok: false, agent: name, error: `${channelFailureText(info.channelId, r)}。窗口已关、条目置为 stopped 先留着，之后再跑 remove${kept ? `（${kept}）` : ""}` };
    }
  }
  const { repointParentRefs } = await import("./team.js");
  const lost = await o.facts.commit((fresh) => {
    if (!same(fresh.agents[name], info)) return "条目已换代，保留新记录";
    delete fresh.agents[name];
    repointParentRefs(fresh, name);
    return null;
  });
  if (lost) return refuse(`窗口已关，但 registry 没写回：${lost}`);
  o.facts.dropSettings(name);
  await deps.rescan("remove", name);
  if (info.channelId) await deps.agentCleanup(info.channelId, name);
  if ("sessionOnly" in g) return { ok: true, agent: name, lifecycle: true, sessionOnly: true, message: `${name} 已永久移除（会话核对通过，会话归档保留）。` };
  return { ok: true, agent: name, lifecycle: true, message: `${name} 已永久移除（生命周期重核通过，会话归档保留）。` };
}

/** Every refusal says so and never reads as "already gone" or "busy" to killOutcome: the plan does not count it as retired. */
export async function removeLifecycle(name: string, deps: OpsDeps, o: LifecycleRemove): Promise<Record<string, unknown>> {
  const refuse = (why: string) => ({ ok: false, agent: name, refused: true, error: `${name} 生命周期收回拒绝，留待下轮：${why}` });
  const release = o.facts.lock(name);
  if (!release) return refuse("有活的 restart 锁");
  try { return await removeChecked(name, deps, { guard: typeof o.guard === "string" ? parseRemoveGuard(o.guard) : o.guard, facts: o.facts }, refuse); }
  catch (e) { return refuse(`重核或执行出错：${(e as Error).message}`); }
  finally { release(); }
}

/** Production facts: the agent's restart lock, the scheduler's own snapshot over the bridge-style read-only ledger, a CAS registry write. */
export const realLifecycleRemoveFacts: LifecycleRemoveFacts = {
  lock: (name) => (tryLockRestart(name) ? () => unlockRestart(name) : null),
  async replan(policy) {
    const reader = new LedgerReader();
    try {
      const db = reader.get();
      if (!db) throw new Error("台账读不到");
      const now = Date.now();
      return { now, plan: await lifecycleSnapshot(db, policy, now, { strict: true }) };
    } finally { reader.close(); }
  },
  async commit(mutate) {
    const raw = readFileSync(REGISTRY_PATH, "utf8");
    const reg = JSON.parse(raw) as Registry;
    const why = mutate(reg);
    if (!why) await saveRegistry(reg, { expected: raw, check: () => {} });
    return why;
  },
  dropSettings: removeAgentSettings,
};

/** manager.ts `remove <name> --lifecycle-guard <json>` → runRemove's options (an empty value still takes this branch and refuses). */
export const lifecycleRemoveOption = (args: string[]): { lifecycle?: LifecycleRemove } => {
  const i = args.findIndex((a) => a === LIFECYCLE_GUARD_FLAG || a.startsWith(`${LIFECYCLE_GUARD_FLAG}=`));
  if (i < 0) return {};
  const raw = args[i] === LIFECYCLE_GUARD_FLAG ? args[i + 1] ?? "" : args[i].slice(LIFECYCLE_GUARD_FLAG.length + 1);
  return { lifecycle: { guard: raw, facts: realLifecycleRemoveFacts } };
};
