/**
 * Autopilot（mission）的推进器：状态与文案在 lib/missions.ts，唤醒队列 / run 在 lib/autopilot-wake.ts，归类在 lib/autopilot-run.ts。
 * 每次回合结束（任一 runtime 的 agent_status done）先落盘成一次唤醒，宽限期后领取成一个 run、递「接着推进」；
 * run 的回合结束等证据到齐后归类、按结果排下一次、写一行日志（bridge/autopilot-close.ts）。
 * 定时器只是「到点再看一眼」：该做什么都从 missions.json 里的字段算，bridge 重启后 reconcile 重新排，不丢也不重发。
 * 提醒走 deliver（bridge 身份的 notification），不经 Stop hook 的 block 续跑——那条只有 Claude Code 有，且回合永不结束会挡住压缩。
 */
import { watchFile } from "node:fs";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { getAgentStatus, isBusyStatus, subscribeEvents, type BridgeEvent } from "./event-bus.js";
import { REPO_ROOT } from "../lib/repo-root.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { readSessionCtx } from "../lib/usage-cache.js";
import { windowTarget } from "../lib/tmux-helper.js";
import { controlFor } from "../lib/runtimes/index.js";
import { probeTurnAt } from "./turn-probe.js";
import { missionKey, MISSIONS_PATH, nudgeKind, nudgeText, readMissions, updateMissions, type Mission, type NudgeKind } from "../lib/missions.js";
import { AUTOPILOT_TIMING, YIELD_TEXT, yieldReason } from "../lib/autopilot-run.js";
import {
  claimWake, decideFire, enqueueWake, markDelivered, newRunId, noteLongYield, unclaimRun, type TurnSeen,
} from "../lib/autopilot-wake.js";
import { appendRunLog, skippedLogLine } from "../lib/autopilot-log.js";
import {
  initAutopilotEvidence, isTracking, lastHumanMessageAt, takeEvidence, takeTurnActivity, trackedTurn, trackRun, untrackRun,
} from "./autopilot-evidence.js";
import { closeRun, logOrphanRun, pendingCloseOf } from "./autopilot-close.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { turnCuts } from "./turn-cuts.js";

/** 回合结束后等多久再递：让人有机会先开口，也躲开 Stop 之后的收尾（排队消息、typing 清理） */
let GRACE_MS = 45_000;
let path = MISSIONS_PATH;
/** 重排后多久看第一眼：bridge 刚起来时给 channel-server 一点重连的时间 */
let RECONCILE_DELAY_MS = 5_000;
/** missions.json 写锁最多等多久（lib/missions.ts 默认 10 秒）、超时后多久重试；单测缩短，好复现写锁超时 */
let LOCK_MS: number | undefined;
let LOCK_RETRY_MS: number = AUTOPILOT_TIMING.lockRetryMs;
const upd = <T>(mutate: (m: Record<string, Mission>) => T) => updateMissions(mutate, path, LOCK_MS);
/**
 * 主回合在不在跑（N7 turnState.main）：压缩中也算忙；只剩后台在跑不算。画面认不出 → unknown（让位时放行，否则会永远递不出去）。
 * Codex / Pi 只能看事件态：bridge 刚重启时事件态是空的，这时也是 unknown，不能当成空闲去收尾在跑的 run。
 */
let turnSeen = async (agent: string): Promise<TurnSeen> => {
  const reg = agent === "master" ? undefined : readRegistryAgentsSync().find((a) => missionKey(a.name) === agent);
  if (agent !== "master" && !reg) return "unknown";
  const main = (await probeTurnAt(windowTarget(reg ? reg.name : "master"), reg?.runtime, agent)).main;
  if (main === "busy" || main === "compacting") return "busy";
  const noStatus = getAgentStatus(agent) === undefined && getAgentStatus(`agent-${agent}`) === undefined;
  return main === "unknown" || (noStatus && !controlFor(reg?.runtime).paneHeuristics) ? "unknown" : "idle";
};
/** 单测：状态文件指到临时目录、宽限期缩短、判忙换成假的；生产不调 */
export function setMissionTestHooks(h: {
  path?: string; graceMs?: number; reconcileDelayMs?: number; lockMs?: number; lockRetryMs?: number; turnSeen?: (agent: string) => Promise<TurnSeen>;
}): void {
  if (h.lockMs !== undefined) LOCK_MS = h.lockMs;
  if (h.lockRetryMs !== undefined) LOCK_RETRY_MS = h.lockRetryMs;
  if (h.path) path = h.path;
  if (h.graceMs !== undefined) GRACE_MS = h.graceMs;
  if (h.reconcileDelayMs !== undefined) RECONCILE_DELAY_MS = h.reconcileDelayMs;
  if (h.turnSeen) turnSeen = h.turnSeen;
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
/** 本进程已经递出去、但「已投递」可能没落盘（写锁超时）的 run：绝不再放回队列重投 */
const deliveredHere = new Set<string>();
const DONE_CMD = (agent: string) => `bun ${join(REPO_ROOT, "src/manager.ts")} mission done ${agent}`;
const iso = (ms: number) => new Date(ms).toISOString();
const ctx = () => ({ path, graceMs: GRACE_MS, lockMs: LOCK_MS });

function channelOf(agent: string): string | null {
  if (agent === "master") return deps?.controlChannelId || null;
  return readRegistryAgentsSync().find((a) => missionKey(a.name) === agent)?.channelId ?? null;
}
/** 事件属于哪个 agent：按频道认（bridge 有的事件 agent 字段填的是频道 id），认不出再用 agent 字段 */
function agentOfEvent(evt: BridgeEvent): string {
  if (deps?.controlChannelId && evt.chatId === deps.controlChannelId) return "master";
  const hit = readRegistryAgentsSync().find((a) => a.channelId === evt.chatId);
  return missionKey(hit?.name ?? evt.agent);
}
const clientOf = (agent: string) => {
  const channelId = channelOf(agent);
  const client = channelId ? deps?.clients.get(channelId) : undefined;
  return channelId && client ? { channelId, client } : null;
};
const busyNow = async (agent: string) =>
  isBusyStatus(getAgentStatus(agent)) || isBusyStatus(getAgentStatus(`agent-${agent}`)) || (await turnSeen(agent)) === "busy";

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
function afterClose(agent: string, m: Mission | null): void {
  if (m?.status === "active") schedule(agent, Date.parse(m.wake?.dueAt ?? iso(Date.now())) - Date.now(), m);
}

/** 收尾写锁超时的 run 各自一个重试定时器（按 runId 去重） */
const closeRetry = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 收尾并排下一次。写锁超时（证据进了 pendingClose）时 deliveredHere 留着——否则这个没标上「已投递」的 run 会被当成
 * 领了没递、过 claimStaleMs 放回去重投——然后一会儿重试。重试不挂在 mission 的定时器上：等锁那几秒里 stop / 换代 / 到点，
 * 那个定时器会被 reconcile 撤掉或改排给新一代，这个 run 的收尾和日志就再也补不上（tests/bridge-mission.test.ts）。
 */
async function closeAndNext(agent: string, runId: string, opts: Parameters<typeof closeRun>[3] = {}): Promise<void> {
  const closed = await closeRun(agent, runId, ctx(), opts);
  if (pendingCloseOf(runId)) {
    if (!closeRetry.has(runId)) closeRetry.set(runId, setTimeout(() => {
      closeRetry.delete(runId);
      closeAndNext(agent, runId).catch((e) => console.error(`⏱ Autopilot ${agent}: run ${runId} 收尾重试失败:`, (e as Error).message));
    }, LOCK_RETRY_MS));
    return;
  }
  clearTimeout(closeRetry.get(runId)); // 别的路径（mission 定时器到点）先收成了
  closeRetry.delete(runId);
  deliveredHere.delete(runId);
  earlyDone.delete(runId);
  afterClose(agent, closed);
}

/** 递一句；不在线、deliver 报 error / dropped（没送到）都算没递出去，返回 false（让位由调用方先判过） */
async function sendNudge(agent: string, m: Mission, kind: NudgeKind, now: number): Promise<boolean> {
  const c = deps && clientOf(agent);
  if (!deps || !c) return false;
  deps.lastMessageSource.set(c.channelId, "agent"); // 这条是 bridge 发的：处理完的 Stop 不去 @ 用户
  const r = (await deps.deliver({
    from: { kind: "bridge", label: "mission" },
    to: { kind: "local", channelId: c.channelId, ws: c.client.ws, cwd: c.client.cwd },
    intent: "notification",
    content: nudgeText(m, kind, now, DONE_CMD(agent)),
    meta: { messageId: newMessageId("mission"), triggerKind: "bridge_synth", ts: iso(now), threadId: newThreadId() },
  })) as { outcome?: { kind?: string; reason?: string } } | undefined;
  const failed = r?.outcome?.kind === "error" || r?.outcome?.kind === "dropped";
  console.log(`⏱ Autopilot ${agent}: ${failed ? `${kind} 没递出去（${r?.outcome?.kind}）` : `递出 ${kind}（第 ${m.nudges + 1} 次）`}`);
  return !failed;
}

// ── 到点 ──

/** 到点：先把这一代标 expired（不管 agent 忙不忙、在不在线，立刻不再续跑），收尾那句另行投递；在跑的 run 按已有证据收尾 */
async function expire(agent: string, id: string | undefined, now: number): Promise<Mission | null> {
  const run = (await readMissions(path))[agent]?.run;
  const gone = await upd((all): Mission | null => {
    const cur = all[agent];
    if (!cur || cur.status !== "active" || cur.id !== id) return null;
    Object.assign(cur, { status: "expired", finishedAt: iso(now) });
    delete cur.resumeAt;
    delete cur.wake;
    return { ...cur };
  });
  if (gone && run?.deliveredAt) await closeAndNext(agent, run.runId); // 已经 expired：收成功也不再排下一次，写锁超时照样重试
  return gone;
}
/** 到点时 agent 正忙 / 不在线：收尾那句等它下一次回合结束再递。只在内存、绑定那一代：新一代开始就作废（别把「已关闭」发给新一代） */
const wrapups = new Map<string, Mission>();

async function deliverWrapup(agent: string, m: Mission, now: number): Promise<void> {
  if (!(await busyNow(agent)) && (await sendNudge(agent, m, "deadline", now))) wrapups.delete(agent);
  else wrapups.set(agent, m);
}

// ── 定时器到点 ──

/** 让位：主回合在跑、人刚说过话（含点了打断）、agent 不在线。排太久记一行「未推进」（每条唤醒只记一次） */
async function yieldIfNeeded(agent: string, m: Mission, now: number): Promise<boolean> {
  const ch = channelOf(agent) ?? undefined;
  const hold = ch ? turnCuts.interruptHold(ch) : null; // 「停」之后不替人续上（bridge/turn-cuts.ts）
  const why = yieldReason({ online: !!clientOf(agent), turnBusy: await busyNow(agent), lastHumanAt: lastHumanMessageAt(agent, ch), interruptHold: hold }, now);
  if (!why) return false;
  const logged = await upd((all) => {
    const cur = all[agent];
    return cur?.status === "active" && cur.id === m.id && noteLongYield(cur, now) ? { ...cur.wake! } : null;
  });
  if (logged) appendRunLog(skippedLogLine({ missionId: m.id ?? "unknown", agent, wake: logged, reason: YIELD_TEXT[why], now }));
  schedule(agent, AUTOPILOT_TIMING.yieldRecheckMs, m);
  return true;
}

/** 投递还没标完「已投递」，这个 run 的回合就结束了（极短的一轮）：先记下，标完再收尾 */
const earlyDone = new Map<string, number>();

/** 标「已投递」：写锁超时也不能让它回到队列（提醒已经发出去了）——记在内存里，下一次到点补标 */
async function persistDelivered(agent: string, runId: string, now: number): Promise<boolean> {
  deliveredHere.add(runId);
  try {
    await upd((all) => {
      const cur = all[agent];
      if (cur && markDelivered(cur, runId, now)) Object.assign(cur, { nudges: cur.nudges + 1, lastNudgeAt: iso(now) });
    });
    return true;
  } catch (e) {
    console.error(`⏱ Autopilot ${agent}: 标记已投递失败，稍后补标:`, (e as Error).message);
    return false;
  }
}

/** 领取 → 记账 → 递提醒 → 标已投递；递不出去原样放回，短退避后再试 */
async function claimAndNudge(agent: string, m: Mission, now: number): Promise<void> {
  const runId = newRunId(now);
  const run = await upd((all) => {
    const cur = all[agent];
    return cur?.status === "active" && cur.id === m.id ? claimWake(cur, now, runId) : null;
  });
  if (!run) return schedule(agent, AUTOPILOT_TIMING.yieldRecheckMs, m);
  logOrphanRun(agent, undefined); // 旧一代还在记账的 run 先补一行，别被新 run 的记账覆盖
  trackRun(agent, run, m.id ?? "unknown", channelOf(agent) ?? undefined); // 先记账再投递：回合开头的工具调用别漏
  let ok = false;
  try {
    ok = await sendNudge(agent, m, nudgeKind(m, now, ctxRatio(agent)), now);
  } catch (e) {
    console.error(`⏱ Autopilot ${agent}: 投递抛错:`, (e as Error).message);
  }
  if (!ok) {
    untrackRun(agent, runId);
    // 放回失败（写锁超时）也无妨：领了没投递的 run 过 claimStaleMs 会被 decideFire 放回
    await upd((all) => void (all[agent] && unclaimRun(all[agent], runId, now, AUTOPILOT_TIMING.yieldRecheckMs))).catch((e) =>
      console.error(`⏱ Autopilot ${agent}: 放回队列失败，等超时放回:`, (e as Error).message));
    return schedule(agent, AUTOPILOT_TIMING.yieldRecheckMs, m);
  }
  const saved = await persistDelivered(agent, runId, now);
  const doneAt = earlyDone.get(runId);
  if (saved && doneAt !== undefined) return closeAndNext(agent, runId, { afterDone: doneAt });
  schedule(agent, saved ? AUTOPILOT_TIMING.runStaleMs : LOCK_RETRY_MS, m);
}

/** fire 里除了「试着推进」以外的几步：都只动落盘状态，然后马上再看一眼 */
async function applyStep(agent: string, m: Mission, step: ReturnType<typeof decideFire>, now: number): Promise<void> {
  const runId = m.run?.runId;
  if (step.kind === "close") {
    const ev = step.lost ? takeEvidence(agent, runId!) : { ...takeEvidence(agent, runId!), failure: step.failure };
    return closeAndNext(agent, runId!, { ev });
  }
  if (step.kind === "mark_delivered") {
    const saved = await persistDelivered(agent, runId!, Date.parse(m.run!.claimedAt));
    const doneAt = earlyDone.get(runId!);
    if (saved && doneAt !== undefined) return closeAndNext(agent, runId!, { afterDone: doneAt }); // 回合早就结束了：补标之后立刻收
    return schedule(agent, saved ? 0 : LOCK_RETRY_MS, m);
  } else {
    await upd((all) => {
      const cur = all[agent];
      if (cur?.status !== "active" || cur.id !== m.id) return;
      if (step.kind === "unclaim" && cur.run) unclaimRun(cur, cur.run.runId, now, 0);
      if (step.kind === "enqueue_start" && !cur.wake && !cur.run) {
        const legacy = step.dueAt > now; // 旧版还在退避的 resumeAt：照旧等，人说话可以提前放行
        enqueueWake(cur, { source: "start", dueAt: step.dueAt, ...(legacy ? { hold: "standby" as const } : {}) }, now);
      }
    });
  }
  schedule(agent, 0, m);
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
  const r = m.run;
  if (r && pendingCloseOf(r.runId)) return closeAndNext(agent, r.runId); // 上次收尾写锁超时：用留下的证据重试
  const turn: TurnSeen = r?.deliveredAt ? await turnSeen(agent) : "idle";
  const step = decideFire(m, now, { turn, tracked: !!r && isTracking(agent, r.runId), deliveredHere: !!r && deliveredHere.has(r.runId) });
  if (step.kind === "wait") return schedule(agent, step.ms, m);
  if (step.kind !== "try") return applyStep(agent, m, step, now);
  if (await yieldIfNeeded(agent, m, now)) return;
  await claimAndNudge(agent, m, now);
}

// ── 回合结束 ──

/**
 * 回合结束：旧一代欠着的收尾作废 / 补递；有已投递的 run 就等证据到齐再收它；否则（人工回合）入队一次唤醒。
 * 本进程在记账的 run 只认投递之后的 done（事件到达那一刻已见过 thinking，snap 是那一刻拍下的）——领取前后迟到的
 * 上一回合 Stop 不算。重启过（没在记账）就照收。
 */
async function onTurnDone(agent: string, snap: ReturnType<typeof trackedTurn>, active: boolean): Promise<void> {
  const now = Date.now();
  const pre = (await readMissions(path))[agent];
  const owed = wrapups.get(agent);
  if (owed && pre?.status === "active" && pre.id !== owed.id) wrapups.delete(agent);
  else if (owed) return deliverWrapup(agent, owed, now);
  logOrphanRun(agent, pre?.run?.runId);
  if (!pre) return; // 没有 Autopilot 的 agent 不碰文件
  const r = pre.run;
  if (r) {
    const tracked = isTracking(agent, r.runId);
    if (tracked && !(snap?.runId === r.runId && snap.started)) return; // 上一回合迟到的 Stop
    if (r.deliveredAt || deliveredHere.has(r.runId)) return closeAndNext(agent, r.runId, tracked ? { afterDone: now } : {});
    if (tracked) earlyDone.set(r.runId, now);
    return;
  }
  if (pre.status !== "active") return;
  // 只有真实的新回合（上一个 done 之后有活动）或人类信号才放行待命 / 等人拍板；重复的 Stop、reconcile 补发的 done 不算
  const humanSince = (lastHumanMessageAt(agent, channelOf(agent) ?? undefined) ?? 0) > Date.parse(pre.lastRun?.endedAt ?? "1970-01-01T00:00:00Z");
  if (!active && !humanSince) return;
  const m = await upd((all) => {
    const cur = all[agent];
    if (cur?.status !== "active" || cur.id !== pre.id || cur.run) return null;
    const w = enqueueWake(cur, { source: "turn_end", dueAt: now + GRACE_MS }, now);
    if (w.hold) cur.resumeAt = w.dueAt;
    else delete cur.resumeAt;
    return { ...cur };
  });
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
    if (m.status !== "active") continue;
    if (wrapups.get(m.agent) && wrapups.get(m.agent)!.id !== m.id) wrapups.delete(m.agent);
    if (!timers.has(m.agent) || timerGen.get(m.agent) !== m.id) schedule(m.agent, RECONCILE_DELAY_MS, m);
  }
}

export function initMission(d: MissionDeps): void {
  deps = d;
  initAutopilotEvidence();
  subscribeEvents({}, (evt) => {
    const d = evt.data as { status?: unknown; reason?: unknown };
    // bridge 重启时给每个频道补发的 done 不是回合结束：当成回合结束会把「等人拍板 / 待命」提前放行；在跑的 run 由 decideFire 按画面收尾
    if (evt.type !== "agent_status" || d?.status !== "done" || d.reason === "bridge_restarted") return;
    const agent = agentOfEvent(evt);
    onTurnDone(agent, trackedTurn(agent), takeTurnActivity(agent, evt.chatId)).catch((e) => console.error("⏱ Autopilot 回合结束处理失败:", (e as Error).message));
  });
  const rerun = (why: string) => () => void reconcileMissions().catch((e) => console.error(`⏱ Autopilot ${why}失败:`, (e as Error).message));
  watchFile(path, { interval: 5_000 }, rerun("重排"));
  setTimeout(rerun("启动重排"), 20_000).unref?.();
  setInterval(rerun("巡检"), 60_000).unref?.();
}
