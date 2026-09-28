/**
 * 值守的推进器（状态与裁决在 lib/missions.ts）。挂在事件总线上：任一 runtime 的回合结束（agent_status done）后
 * 等 GRACE_MS，确认 agent 仍空闲（期间人来说话了就让位，下一次 done 再说）才递提醒；到截止时间递最后一句并关闭值守。
 * 定时器只在内存：bridge 重启、manager 从命令行改了 missions.json 都靠 reconcile() 重新排（监听文件 + 启动时各一次）。
 * 提醒走 deliver（bridge 身份的 notification），不经 Stop hook 的 block 续跑——那条只有 Claude Code 有，且回合永不结束会挡住压缩。
 */
import { watchFile } from "node:fs";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { getAgentStatus, isBusyStatus, subscribeEvents } from "./event-bus.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { windowTarget } from "../lib/tmux-helper.js";
import { agentMsgMustWait } from "../lib/turn-state.js";
import { probeTurnAt } from "./turn-probe.js";
import {
  backoffMs, missionKey, MISSIONS_PATH, nextFastTurns, nudgeKind, nudgeText, readMissions, updateMissions, type Mission, type NudgeKind,
} from "../lib/missions.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";

/** 回合结束后等多久再递：让人有机会先开口，也躲开 Stop 之后的收尾（排队消息、typing 清理） */
let GRACE_MS = 45_000;
let path = MISSIONS_PATH;
/**
 * 事件总线只在 bridge 投递时才知道「在忙」：bridge 刚重启、或 agent 自己续着干，状态表是空的。递提醒前再按 turnState 判一次：
 * 主回合在跑 / 压缩中才让位；只剩后台在跑不算忙。
 * unknown 放行——认不出画面就挡，值守会永远递不出去。
 */
let turnBusy = async (agent: string): Promise<boolean> => {
  const reg = agent === "master" ? undefined : readRegistryAgentsSync().find((a) => missionKey(a.name) === agent);
  if (agent !== "master" && !reg) return false;
  return agentMsgMustWait(await probeTurnAt(windowTarget(reg ? reg.name : "master"), reg?.runtime, agent));
};
/** 单测：状态文件指到临时目录、宽限期缩短、判忙换成假的；生产不调 */
export function setMissionTestHooks(h: { path?: string; graceMs?: number; turnBusy?: (agent: string) => Promise<boolean> }): void {
  if (h.path) path = h.path;
  if (h.graceMs !== undefined) GRACE_MS = h.graceMs;
  if (h.turnBusy) turnBusy = h.turnBusy;
}

interface Client { ws: ServerWebSocket<unknown>; channelId: string; cwd?: string }
export interface MissionDeps {
  clients: Map<string, Client>;
  deliver: (env: Envelope) => Promise<unknown>;
  lastMessageSource: { set(channelId: string, src: "agent"): unknown };
  controlChannelId?: string;
}

let deps: MissionDeps | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** 递出提醒、还没等到它的回合结束：这段时间里文件变动引起的重排不再补递（否则一次提醒会被自己写的文件再触发一次） */
const awaitingTurn = new Map<string, number>();
const AWAIT_TURN_MAX_MS = 30 * 60_000;
const DONE_CMD = (agent: string) => `bun ${join(REPO_ROOT, "src/manager.ts")} mission done ${agent}`;

function channelOf(agent: string): string | null {
  if (agent === "master") return deps?.controlChannelId || null;
  const hit = readRegistryAgentsSync().find((a) => missionKey(a.name) === agent);
  return hit?.channelId ?? null;
}

/** 上下文占比（0–1）；拿不到（master、非 Claude Code、statusline 没落盘）→ null，只是不提醒压缩 */
function ctxRatio(agent: string): number | null {
  const sid = readRegistryAgentsSync().find((a) => missionKey(a.name) === agent)?.sessionId;
  const pct = sid ? readSessionCtx(sid)?.usedPct : null;
  return typeof pct === "number" ? pct / 100 : null;
}

function schedule(agent: string, delayMs: number): void {
  clearTimeout(timers.get(agent));
  timers.set(agent, setTimeout(() => void fire(agent), Math.max(0, delayMs)));
}

/** 到点：先把这一代标 expired（不管 agent 忙不忙、在不在线，值守立刻不再续跑），收尾那句另行投递 */
async function expire(agent: string, id: string | undefined): Promise<Mission | null> {
  return updateMissions((all): Mission | null => {
    const cur = all[agent];
    if (!cur || cur.status !== "active" || cur.id !== id) return null;
    Object.assign(cur, { status: "expired", finishedAt: new Date().toISOString() });
    delete cur.resumeAt;
    return { ...cur };
  }, path);
}
/** 到点时 agent 正忙 / 不在线：收尾那句等它下一次回合结束再递（只在内存，bridge 重启就不补了——值守已经关了） */
const wrapups = new Map<string, Mission>();

/** 递一句；忙 / 不在线 / 这一代已经不是它（续跑类）就不递，返回 false */
async function tryDeliver(agent: string, m: Mission, kind: NudgeKind, now: number): Promise<boolean> {
  if (!deps) return false;
  // 人在跟它说话（或它自己还在干）：让位，等下一次回合结束
  if (isBusyStatus(getAgentStatus(agent)) || isBusyStatus(getAgentStatus(`agent-${agent}`))) return false;
  if (await turnBusy(agent)) return false;
  const channelId = channelOf(agent);
  const client = channelId ? deps.clients.get(channelId) : undefined;
  if (!channelId || !client) {
    console.warn(`⏱ 值守 ${agent}: agent 不在线，等它连上后的下一次回合结束`);
    return false;
  }
  if (kind !== "deadline") {
    const cur = (await readMissions(path))[agent];
    if (cur?.status !== "active" || cur.id !== m.id) return false; // 这期间被 stop / 重开了：旧一代的提醒不发
  }
  deps.lastMessageSource.set(channelId, "agent"); // 这条是 bridge 发的：处理完的 Stop 不去 @ 用户
  await deps.deliver({
    from: { kind: "bridge", label: "mission" },
    to: { kind: "local", channelId, ws: client.ws, cwd: client.cwd },
    intent: "notification",
    content: nudgeText(m, kind, now, DONE_CMD(agent)),
    meta: { messageId: newMessageId("mission"), triggerKind: "bridge_synth", ts: new Date(now).toISOString(), threadId: newThreadId() },
  });
  console.log(`⏱ 值守 ${agent}: 递出 ${kind}（第 ${m.nudges + 1} 次）`);
  return true;
}

async function fire(agent: string): Promise<void> {
  timers.delete(agent);
  if (!deps) return;
  const m = (await readMissions(path))[agent];
  if (!m || m.status !== "active") return;
  const now = Date.now();
  const kind = nudgeKind(m, now, ctxRatio(agent));
  if (kind === "deadline") {
    const gone = await expire(agent, m.id);
    if (gone && !(await tryDeliver(agent, gone, "deadline", now))) wrapups.set(agent, gone);
    return;
  }
  if (m.resumeAt && Date.parse(m.resumeAt) > now) return schedule(agent, Date.parse(m.resumeAt) - now);
  if (!(await tryDeliver(agent, m, kind, now))) return;
  awaitingTurn.set(agent, now);
  await updateMissions((all) => {
    const cur = all[agent];
    if (!cur || cur.status !== "active" || cur.id !== m.id) return;
    cur.nudges += 1;
    cur.lastNudgeAt = new Date(now).toISOString();
  }, path);
}

/** 回合结束：先补递欠着的收尾；有进行中的值守才记空转、必要时退避，然后排下一次提醒 */
async function onTurnDone(agentLabel: string): Promise<void> {
  const agent = missionKey(agentLabel);
  const now = Date.now();
  awaitingTurn.delete(agent);
  const owed = wrapups.get(agent);
  if (owed) {
    if (await tryDeliver(agent, owed, "deadline", now)) wrapups.delete(agent);
    return;
  }
  const pre = (await readMissions(path))[agent];
  if (!pre || pre.status !== "active") return; // 没有值守的 agent 不碰文件
  const m = await updateMissions((all): Mission | null => {
    const cur = all[agent];
    if (!cur || cur.status !== "active" || cur.id !== pre.id) return null;
    cur.fastTurns = nextFastTurns(cur, now);
    const wait = backoffMs(cur.fastTurns);
    if (wait) cur.resumeAt = new Date(now + wait).toISOString();
    else delete cur.resumeAt;
    return { ...cur };
  }, path);
  if (!m) return;
  const untilMs = Date.parse(m.until) - now;
  const resumeMs = m.resumeAt ? Date.parse(m.resumeAt) - now : 0;
  schedule(agent, Math.min(Math.max(GRACE_MS, resumeMs), Math.max(untilMs, 0) + GRACE_MS));
}

/**
 * 按文件重排：新开的值守（agent 正空闲）尽快递第一句；关掉的撤定时器；到点的立刻收。刚递过提醒、还在等它这一轮的，
 * 只排到点那一下。文件监听 + 每分钟一次兜底：漏了 done 事件、或文件没人写，也不会永远停住。
 */
async function reconcile(): Promise<void> {
  const all = await readMissions(path);
  for (const agent of timers.keys()) if (all[agent]?.status !== "active") clearTimeout(timers.get(agent)), timers.delete(agent);
  const now = Date.now();
  for (const m of Object.values(all)) {
    if (m.status !== "active" || timers.has(m.agent)) continue;
    const untilIn = Math.max(Date.parse(m.until) - now, 0) + 5_000;
    if (now - (awaitingTurn.get(m.agent) ?? 0) < AWAIT_TURN_MAX_MS) {
      schedule(m.agent, untilIn);
      continue;
    }
    const resume = m.resumeAt ? Date.parse(m.resumeAt) - now : 0;
    schedule(m.agent, Math.min(Math.max(5_000, resume), untilIn));
  }
}

export function initMission(d: MissionDeps): void {
  deps = d;
  subscribeEvents({}, (evt) => {
    if (evt.type !== "agent_status" || (evt.data as { status?: unknown })?.status !== "done") return;
    onTurnDone(evt.agent).catch((e) => console.error("⏱ 值守回合结束处理失败:", (e as Error).message));
  });
  const rerun = (why: string) => () => void reconcile().catch((e) => console.error(`⏱ 值守${why}失败:`, (e as Error).message));
  watchFile(path, { interval: 5_000 }, rerun("重排"));
  setTimeout(rerun("启动重排"), 20_000).unref?.();
  setInterval(rerun("巡检"), 60_000).unref?.();
}
