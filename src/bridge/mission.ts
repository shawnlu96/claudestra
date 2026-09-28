/**
 * Autopilot（mission）的推进器：状态与文案在 lib/missions.ts，唤醒队列 / run 在 lib/autopilot-wake.ts，归类在 lib/autopilot-run.ts。
 * 每次回合结束（任一 runtime 的 agent_status done）先落盘成一次唤醒，宽限期后领取成一个 run、递「接着推进」；
 * run 的回合结束按事件证据归类（bridge/autopilot-evidence.ts），按结果排下一次，并写一行日志（lib/autopilot-log.ts）。
 * 定时器只是「到点再看一眼」：该做什么都从 missions.json 里的字段算，bridge 重启后 reconcile 重新排，不丢也不重发。
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
import { missionKey, MISSIONS_PATH, nudgeKind, nudgeText, readMissions, updateMissions, type Mission, type NudgeKind } from "../lib/missions.js";
import { AUTOPILOT_TIMING, classifyRun, YIELD_TEXT, yieldReason, type RunEvidence } from "../lib/autopilot-run.js";
import {
  claimWake, decideFire, enqueueWake, finishRun, markDelivered, newRunId, noteLongYield, unclaimRun, type ActiveRun,
} from "../lib/autopilot-wake.js";
import { appendRunLog, runLogLine, skippedLogLine } from "../lib/autopilot-log.js";
import { initAutopilotEvidence, isTracking, lastHumanMessageAt, takeEvidence, trackRun, untrackRun } from "./autopilot-evidence.js";
import { newThreadId, type Envelope } from "./router.js";

/** 回合结束后等多久再递：让人有机会先开口，也躲开 Stop 之后的收尾（排队消息、typing 清理） */
let GRACE_MS = 45_000;
let path = MISSIONS_PATH;
/** 重排后多久看第一眼：bridge 刚起来时给 channel-server 一点重连的时间 */
let RECONCILE_DELAY_MS = 5_000;
/**
 * 事件总线只在 bridge 投递时才知道「在忙」：bridge 刚重启、或 agent 自己续着干，状态表是空的。递提醒前再按 turnState 判一次：
 * 主回合在跑 / 压缩中才让位；只剩后台在跑不算忙。unknown 放行——认不出画面就挡，Autopilot 会永远递不出去。
 */
let turnBusy = async (agent: string): Promise<boolean> => {
  const reg = agent === "master" ? undefined : readRegistryAgentsSync().find((a) => missionKey(a.name) === agent);
  if (agent !== "master" && !reg) return false;
  return agentMsgMustWait(await probeTurnAt(windowTarget(reg ? reg.name : "master"), reg?.runtime, agent));
};
/** 单测：状态文件指到临时目录、宽限期缩短、判忙换成假的；生产不调 */
export function setMissionTestHooks(h: { path?: string; graceMs?: number; reconcileDelayMs?: number; turnBusy?: (agent: string) => Promise<boolean> }): void {
  if (h.path) path = h.path;
  if (h.graceMs !== undefined) GRACE_MS = h.graceMs;
  if (h.reconcileDelayMs !== undefined) RECONCILE_DELAY_MS = h.reconcileDelayMs;
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
/** 定时器是为哪一代排的：stop 再 start（新 id）时旧一代留下的长定时器（额度 / 待命）不能挡住新一代的第一句 */
const timerGen = new Map<string, string | undefined>();
const DONE_CMD = (agent: string) => `bun ${join(REPO_ROOT, "src/manager.ts")} mission done ${agent}`;
const iso = (ms: number) => new Date(ms).toISOString();

function channelOf(agent: string): string | null {
  if (agent === "master") return deps?.controlChannelId || null;
  return readRegistryAgentsSync().find((a) => missionKey(a.name) === agent)?.channelId ?? null;
}
const clientOf = (agent: string) => {
  const channelId = channelOf(agent);
  const client = channelId ? deps?.clients.get(channelId) : undefined;
  return channelId && client ? { channelId, client } : null;
};
const busyNow = async (agent: string) =>
  isBusyStatus(getAgentStatus(agent)) || isBusyStatus(getAgentStatus(`agent-${agent}`)) || (await turnBusy(agent));

/** 上下文占比（0–1）；拿不到（master、非 Claude Code、statusline 没落盘）→ null，只是不提醒压缩 */
function ctxRatio(agent: string): number | null {
  const sid = readRegistryAgentsSync().find((a) => missionKey(a.name) === agent)?.sessionId;
  const pct = sid ? readSessionCtx(sid)?.usedPct : null;
  return typeof pct === "number" ? pct / 100 : null;
}

/** 下一次看一眼：不晚于截止时间（到点要立刻收） */
function schedule(agent: string, delayMs: number, m: Pick<Mission, "until" | "id">): void {
  clearTimeout(timers.get(agent));
  timerGen.set(agent, m.id);
  const cap = Math.max(Date.parse(m.until) - Date.now(), 0) + 1000;
  timers.set(agent, setTimeout(() => void fire(agent).catch((e) => console.error(`⏱ Autopilot ${agent} 推进失败:`, (e as Error).message)), Math.max(0, Math.min(delayMs, cap))));
}

/** 递一句；不在线就不递，返回 false（让位由调用方先判过） */
async function sendNudge(agent: string, m: Mission, kind: NudgeKind, now: number): Promise<boolean> {
  const c = deps && clientOf(agent);
  if (!deps || !c) return false;
  deps.lastMessageSource.set(c.channelId, "agent"); // 这条是 bridge 发的：处理完的 Stop 不去 @ 用户
  await deps.deliver({
    from: { kind: "bridge", label: "mission" },
    to: { kind: "local", channelId: c.channelId, ws: c.client.ws, cwd: c.client.cwd },
    intent: "notification",
    content: nudgeText(m, kind, now, DONE_CMD(agent)),
    meta: { messageId: `mission_${now}`, triggerKind: "bridge_synth", ts: iso(now), threadId: newThreadId() },
  });
  console.log(`⏱ Autopilot ${agent}: 递出 ${kind}（第 ${m.nudges + 1} 次）`);
  return true;
}

// ── run 收尾 ──

/** 收一个 run：只认 runId 对得上的那一个（重复 done、旧一代都不收），写一行日志；mission 已不在进行中就不再排下一次 */
async function closeRun(agent: string, runId: string, ev: RunEvidence, now: number): Promise<Mission | null> {
  const cls = classifyRun(ev);
  const out = await updateMissions((all) => {
    const cur = all[agent];
    if (!cur || cur.run?.runId !== runId) return null;
    const run: ActiveRun = cur.run;
    const f = finishRun(cur, runId, cls.outcome, ev, now, GRACE_MS)!;
    if (cur.status !== "active") delete cur.wake;
    if (f.next.hold && cur.status === "active") cur.resumeAt = iso(f.nextAt); // 网页「等到 …」
    else delete cur.resumeAt;
    return { m: { ...cur }, run, f };
  }, path);
  if (!out) return null;
  const active = out.m.status === "active";
  appendRunLog(runLogLine({
    missionId: out.m.id ?? "unknown", agent, run: out.run, outcome: cls.outcome, reason: cls.reason, evidence: ev, now,
    ...(active ? { next: { at: out.f.nextAt, why: out.f.next.why } } : {}),
  }));
  console.log(`⏱ Autopilot ${agent}: run ${runId} → ${cls.outcome}（${cls.reason}）${active ? `，下次 ${out.f.next.why}` : ""}`);
  return out.m;
}

// ── 到点 ──

/** 到点：先把这一代标 expired（不管 agent 忙不忙、在不在线，立刻不再续跑），收尾那句另行投递；在跑的 run 按已有证据收尾 */
async function expire(agent: string, id: string | undefined, now: number): Promise<Mission | null> {
  const run = (await readMissions(path))[agent]?.run;
  const gone = await updateMissions((all): Mission | null => {
    const cur = all[agent];
    if (!cur || cur.status !== "active" || cur.id !== id) return null;
    Object.assign(cur, { status: "expired", finishedAt: iso(now) });
    delete cur.resumeAt;
    delete cur.wake;
    return { ...cur };
  }, path);
  if (gone && run?.deliveredAt) await closeRun(agent, run.runId, takeEvidence(agent, run.runId), now);
  return gone;
}
/** 到点时 agent 正忙 / 不在线：收尾那句等它下一次回合结束再递（只在内存，bridge 重启就不补了——Autopilot 已经关了） */
const wrapups = new Map<string, Mission>();

async function deliverWrapup(agent: string, m: Mission, now: number): Promise<void> {
  if (!(await busyNow(agent)) && (await sendNudge(agent, m, "deadline", now))) wrapups.delete(agent);
  else wrapups.set(agent, m);
}

// ── 定时器到点 ──

/** 让位：主回合在跑、人刚说过话、agent 不在线。排太久记一行「未推进」（每条唤醒只记一次） */
async function yieldIfNeeded(agent: string, m: Mission, now: number): Promise<boolean> {
  const why = yieldReason({ online: !!clientOf(agent), turnBusy: await busyNow(agent), lastHumanAt: lastHumanMessageAt(agent) }, now);
  if (!why) return false;
  const logged = await updateMissions((all) => {
    const cur = all[agent];
    return cur?.status === "active" && cur.id === m.id && noteLongYield(cur, now) ? { ...cur.wake! } : null;
  }, path);
  if (logged) appendRunLog(skippedLogLine({ missionId: m.id ?? "unknown", agent, wake: logged, reason: YIELD_TEXT[why], now }));
  schedule(agent, AUTOPILOT_TIMING.yieldRecheckMs, m);
  return true;
}

/** 投递还没标完「已投递」，这个 run 的回合就结束了（极短的一轮）：先记下，标完立刻收尾 */
const earlyDone = new Set<string>();

function afterClose(agent: string, m: Mission | null): void {
  if (m?.status === "active") schedule(agent, Date.parse(m.wake?.dueAt ?? iso(Date.now())) - Date.now(), m);
}

/** 领取 → 记账 → 递提醒 → 标已投递；递不出去原样放回 */
async function claimAndNudge(agent: string, m: Mission, now: number): Promise<void> {
  const runId = newRunId(now);
  const run = await updateMissions((all) => {
    const cur = all[agent];
    return cur?.status === "active" && cur.id === m.id ? claimWake(cur, now, runId) : null;
  }, path);
  if (!run) return schedule(agent, AUTOPILOT_TIMING.yieldRecheckMs, m);
  trackRun(agent, runId); // 先记账再投递：回合开头的工具调用别漏
  let ok = false;
  try {
    ok = await sendNudge(agent, m, nudgeKind(m, now, ctxRatio(agent)), now);
  } finally {
    await updateMissions((all) => {
      const cur = all[agent];
      if (!cur) return;
      if (!ok) return void unclaimRun(cur, runId, now, AUTOPILOT_TIMING.yieldRecheckMs);
      if (markDelivered(cur, runId, now)) Object.assign(cur, { nudges: cur.nudges + 1, lastNudgeAt: iso(now) });
    }, path);
    if (!ok) untrackRun(agent, runId);
  }
  if (ok && earlyDone.delete(runId)) return afterClose(agent, await closeRun(agent, runId, takeEvidence(agent, runId), Date.now()));
  schedule(agent, ok ? AUTOPILOT_TIMING.runStaleMs : AUTOPILOT_TIMING.yieldRecheckMs, m);
}

async function fire(agent: string): Promise<void> {
  timers.delete(agent);
  if (!deps) return;
  const m = (await readMissions(path))[agent];
  if (!m || m.status !== "active") return;
  const now = Date.now();
  if (now >= Date.parse(m.until)) {
    const gone = await expire(agent, m.id, now);
    if (gone) await deliverWrapup(agent, gone, now);
    return;
  }
  const busy = m.run?.deliveredAt ? await busyNow(agent) : false;
  const step = decideFire(m, now, { busy, tracked: !!m.run && isTracking(agent, m.run.runId) });
  if (step.kind === "wait") return schedule(agent, step.ms, m);
  if (step.kind === "close") {
    const ev = step.lost ? takeEvidence(agent, m.run!.runId) : { ...takeEvidence(agent, m.run!.runId), failure: step.failure };
    await closeRun(agent, m.run!.runId, ev, now);
    return schedule(agent, 0, m);
  }
  if (step.kind === "unclaim" || step.kind === "enqueue_start") {
    await updateMissions((all) => {
      const cur = all[agent];
      if (cur?.status !== "active" || cur.id !== m.id) return;
      if (step.kind === "unclaim" && cur.run) unclaimRun(cur, cur.run.runId, now, 0);
      if (step.kind === "enqueue_start" && !cur.wake && !cur.run) enqueueWake(cur, { source: "start", dueAt: now }, now);
    }, path);
    return schedule(agent, 0, m);
  }
  if (await yieldIfNeeded(agent, m, now)) return;
  await claimAndNudge(agent, m, now);
}

// ── 回合结束 ──

/** 回合结束：补递欠着的收尾；有已投递的 run 就收它；否则（人工回合）入队一次唤醒。都排下一次看一眼 */
async function onTurnDone(agentLabel: string): Promise<void> {
  const agent = missionKey(agentLabel);
  const now = Date.now();
  const owed = wrapups.get(agent);
  if (owed) return deliverWrapup(agent, owed, now);
  const pre = (await readMissions(path))[agent];
  if (!pre) return; // 没有 Autopilot 的 agent 不碰文件
  if (pre.run?.deliveredAt) return afterClose(agent, await closeRun(agent, pre.run.runId, takeEvidence(agent, pre.run.runId), now));
  if (pre.run && isTracking(agent, pre.run.runId)) return void earlyDone.add(pre.run.runId);
  if (pre.status !== "active" || pre.run) return;
  const m = await updateMissions((all) => {
    const cur = all[agent];
    if (cur?.status !== "active" || cur.id !== pre.id || cur.run) return null;
    const w = enqueueWake(cur, { source: "turn_end", dueAt: now + GRACE_MS }, now);
    if (w.hold) cur.resumeAt = w.dueAt;
    else delete cur.resumeAt;
    return { ...cur };
  }, path);
  if (m?.wake) schedule(agent, Date.parse(m.wake.dueAt) - now, m);
}

/**
 * 按文件重排：新开的 Autopilot 尽快入队第一次；关掉的撤定时器；其余按落盘的 wake / run 排下一次看一眼。
 * 文件监听 + 每分钟一次兜底：漏了 done 事件、或文件没人写，也不会永远停住；bridge 重启后第一次重排就把 run / 唤醒接上（单测直接调）。
 */
export async function reconcileMissions(): Promise<void> {
  const all = await readMissions(path);
  for (const agent of timers.keys()) if (all[agent]?.status !== "active") clearTimeout(timers.get(agent)), timers.delete(agent);
  for (const m of Object.values(all)) {
    if (m.status === "active" && (!timers.has(m.agent) || timerGen.get(m.agent) !== m.id)) schedule(m.agent, RECONCILE_DELAY_MS, m);
  }
}

export function initMission(d: MissionDeps): void {
  deps = d;
  initAutopilotEvidence();
  subscribeEvents({}, (evt) => {
    if (evt.type !== "agent_status" || (evt.data as { status?: unknown })?.status !== "done") return;
    onTurnDone(evt.agent).catch((e) => console.error("⏱ Autopilot 回合结束处理失败:", (e as Error).message));
  });
  const rerun = (why: string) => () => void reconcileMissions().catch((e) => console.error(`⏱ Autopilot ${why}失败:`, (e as Error).message));
  watchFile(path, { interval: 5_000 }, rerun("重排"));
  setTimeout(rerun("启动重排"), 20_000).unref?.();
  setInterval(rerun("巡检"), 60_000).unref?.();
}
