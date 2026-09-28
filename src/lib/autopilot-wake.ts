/**
 * Autopilot 的持久唤醒队列与 run 领取（纯函数，改的是 missions.json 里那条 Mission 上的字段，调用方持 updateMissions 的锁）。
 * 一个 agent 只有一条 Mission，所以「同时最多一个自主 run」由数据形状保证：wake 最多一条（新触发合并进去），run 最多一条。
 * 去重靠 missionId + 触发序号：领取在锁里把 wake 换成 run，bridge 重启后看到 run 还在就只等它结束、不再投递；
 * wake 还在就接着排——落盘之后既不丢也不重复。tests/autopilot-wake.test.ts。
 */
import { randomBytes } from "node:crypto";
import {
  AUTOPILOT_TIMING, nextStreaks, nextWake, type NextWake, type RunEvidence, type RunOutcome, type RunStreaks, type WakeHold,
} from "./autopilot-run.js";

/** start = 刚开启；turn_end = 回合结束（人工的或上一轮 run 的）；schedule = 定时（后续期）；retry = 投递没成放回 */
export type WakeSource = "start" | "turn_end" | "schedule" | "retry";

export interface Wake {
  /** 最近一次合并进来的触发序号 */
  seq: number;
  source: WakeSource;
  /** 不早于这个时刻领取（ISO） */
  dueAt: string;
  /** 最早到期的时刻（合并进来的触发里最早该推进的那次）：让位太久记「未推进」从这里算，挡在额度 / 待命里的时间不算 */
  firstAt: string;
  /** 合并掉了几次触发 */
  merged: number;
  hold?: WakeHold;
  /** 这条唤醒已经记过一次「未推进」，别每分钟记一行 */
  yieldLogged?: boolean;
}

export interface ActiveRun {
  runId: string;
  seq: number;
  source: WakeSource;
  merged: number;
  firstAt: string;
  claimedAt: string;
  deliveredAt?: string;
}

interface LastRun {
  runId: string;
  outcome: RunOutcome;
  endedAt: string;
  streaks: RunStreaks;
}

/** Mission 上 Autopilot 用的字段（旧数据都没有，全可选） */
export interface AutopilotFields {
  wakeSeq?: number;
  wake?: Wake;
  run?: ActiveRun;
  lastRun?: LastRun;
}

export const newRunId = (now: number): string => `run_${now.toString(36)}_${randomBytes(3).toString("hex")}`;

const iso = (ms: number) => new Date(ms).toISOString();
const releases = (h: WakeHold | undefined) => h === "blocked" || h === "standby";

/**
 * 入队一次触发。已有唤醒就合并：序号取新的、firstAt 留最早的、merged + 1。
 * 带 hold 的（run 结果算出来的下次时间）直接覆盖；不带 hold 的回合结束，只能提前放行 blocked / standby，
 * 额度和失败退避不提前——人聊了一句，额度不会因此恢复。
 */
export function enqueueWake(m: AutopilotFields, t: { source: WakeSource; dueAt: number; hold?: WakeHold }, now: number): Wake {
  const seq = (m.wakeSeq ?? 0) + 1;
  m.wakeSeq = seq;
  const old = m.wake;
  if (!old) {
    m.wake = { seq, source: t.source, dueAt: iso(t.dueAt), firstAt: iso(t.dueAt), merged: 0, ...(t.hold ? { hold: t.hold } : {}) };
    return m.wake;
  }
  const keepOld = !t.hold && old.hold && !releases(old.hold);
  const w: Wake = { ...old, seq, source: t.source, merged: old.merged + 1 };
  if (!keepOld) {
    w.dueAt = iso(t.dueAt);
    // 带 hold 的是新的调度决定，从它重新算；放行 / 普通合并取更早的那个（一直有人聊把 dueAt 往后推，firstAt 不跟着推）
    w.firstAt = t.hold || Date.parse(old.firstAt) > t.dueAt ? iso(t.dueAt) : old.firstAt;
    if (t.hold) w.hold = t.hold;
    else delete w.hold;
  }
  m.wake = w;
  return w;
}

/** 领取：没有进行中的 run、有唤醒、到时间了，才把 wake 换成 run；否则 null */
export function claimWake(m: AutopilotFields, now: number, runId: string): ActiveRun | null {
  const w = m.wake;
  if (m.run || !w || Date.parse(w.dueAt) > now) return null;
  m.run = { runId, seq: w.seq, source: w.source, merged: w.merged, firstAt: w.firstAt, claimedAt: iso(now) };
  delete m.wake;
  return m.run;
}

export function markDelivered(m: AutopilotFields, runId: string, now: number): boolean {
  if (m.run?.runId !== runId) return false;
  m.run.deliveredAt = iso(now);
  return true;
}

/** 领到了却没递出去（领取和投递之间人来了 / agent 掉线）：原样放回，序号不变，retryMs 后再看 */
export function unclaimRun(m: AutopilotFields, runId: string, now: number, retryMs: number): boolean {
  const r = m.run;
  if (r?.runId !== runId || r.deliveredAt) return false;
  delete m.run;
  const w = m.wake; // 领取之后又进来的触发：并进放回的这条，firstAt 留最早的
  m.wake = w
    ? { ...w, firstAt: r.firstAt < w.firstAt ? r.firstAt : w.firstAt, merged: w.merged + r.merged + 1 }
    : { seq: r.seq, source: "retry", dueAt: iso(now + retryMs), firstAt: r.firstAt, merged: r.merged };
  return true;
}

export interface FinishedRun {
  run: ActiveRun;
  outcome: RunOutcome;
  streaks: RunStreaks;
  next: NextWake;
  nextAt: number;
}

/** 收尾：只认当前这个 runId（重复的 done、旧一代的结束都返回 null），记 lastRun，按结果排下一次唤醒 */
export function finishRun(
  m: AutopilotFields, runId: string, outcome: RunOutcome, ev: RunEvidence, now: number, graceMs: number,
): FinishedRun | null {
  const run = m.run;
  if (run?.runId !== runId) return null;
  const streaks = nextStreaks(m.lastRun?.streaks ?? { idle: 0, fail: 0 }, outcome, ev);
  const next = nextWake(outcome, streaks, ev, now, graceMs);
  m.lastRun = { runId, outcome, endedAt: iso(now), streaks };
  delete m.run;
  const nextAt = now + next.delayMs;
  enqueueWake(m, { source: "turn_end", dueAt: nextAt, hold: next.hold }, now);
  return { run, outcome, streaks, next, nextAt };
}

/** 排队等了超过上限还没领到（一直有人在聊）：第一次返回 true 让调用方记一行「未推进」，之后同一条唤醒不再记 */
export function noteLongYield(m: AutopilotFields, now: number): boolean {
  const w = m.wake;
  if (!w || w.yieldLogged || now - Date.parse(w.firstAt) < AUTOPILOT_TIMING.maxYieldDelayMs) return false;
  w.yieldLogged = true;
  return true;
}

/**
 * 定时器到点时该做什么（让位另判：要抓屏、查在线，放在 bridge）。until 以外的时刻都从落盘的字段算，所以 bridge 重启后照样能接上：
 * - run 领了没标投递：本进程知道已经递出去了（标记时写锁超时）→ 补标；否则超过 claimStaleMs 放回（进程在领取和投递之间挂了）
 * - run 已投递：还在忙就等；空闲且本进程没在记账（重启过）→ 按证据不全收尾；忙闲未知（重启后 Codex / Pi 没有事件态）等到 runStaleMs 再收；
 *   本进程在记账、超过 runStaleMs 仍空闲 → 判失败收尾
 * - 没有 wake 也没有 run（刚开启、或旧数据）→ 入队一次 start；旧数据里还在退避的 resumeAt 照旧生效
 */
export type TurnSeen = "busy" | "idle" | "unknown";
export type FireStep =
  | { kind: "wait"; ms: number }
  | { kind: "unclaim" }
  | { kind: "mark_delivered" }
  | { kind: "close"; lost: boolean; failure?: string }
  | { kind: "enqueue_start"; dueAt: number }
  | { kind: "try" };

export function decideFire(
  m: AutopilotFields & { resumeAt?: string }, now: number, s: { turn: TurnSeen; tracked: boolean; deliveredHere?: boolean },
): FireStep {
  const T = AUTOPILOT_TIMING;
  const r = m.run;
  if (r && !r.deliveredAt) {
    if (s.deliveredHere) return { kind: "mark_delivered" };
    const age = now - Date.parse(r.claimedAt);
    return age >= T.claimStaleMs ? { kind: "unclaim" } : { kind: "wait", ms: T.claimStaleMs - age };
  }
  if (r?.deliveredAt) {
    const age = now - Date.parse(r.deliveredAt);
    if (s.turn === "busy") return { kind: "wait", ms: T.yieldRecheckMs * 5 };
    if (!s.tracked && s.turn === "idle") return { kind: "close", lost: true };
    if (age < T.runStaleMs) return { kind: "wait", ms: T.runStaleMs - age };
    if (!s.tracked) return { kind: "close", lost: true };
    return { kind: "close", lost: false, failure: `投递后 ${Math.round(age / 60_000)} 分钟没等到回合结束，agent 已空闲` };
  }
  if (!m.wake) {
    const legacy = m.resumeAt ? Date.parse(m.resumeAt) : NaN;
    return { kind: "enqueue_start", dueAt: Number.isFinite(legacy) && legacy > now ? legacy : now };
  }
  const due = Date.parse(m.wake.dueAt) - now;
  return due > 0 ? { kind: "wait", ms: due } : { kind: "try" };
}
