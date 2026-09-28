/**
 * Autopilot 的单次推进（run）：把一轮的事件证据归成五类结果，再按结果算下一次什么时候醒（纯函数，tests/autopilot-run.test.ts）。
 * 证据来自事件总线（bridge/autopilot-evidence.ts），不靠模型自报：撞额度、API 报错、本轮发出的按钮 / 没答完的提问都是事件。
 * 取代旧的「提醒后 90 秒内结束就算空转 → 5/15/30/60 分钟退避」：那条把额度用尽、在等人、正常很短的一轮混成一类。
 */
import { parseResetText } from "./usage-window.js";

const MINUTE_MS = 60_000;

export type RunOutcome = "normal" | "action_taken" | "blocked_approval" | "rate_limited" | "failed";

export interface RunEvidence {
  /** 本轮调用的工具数（不含 reply 这类通信工具） */
  tools: number;
  /** 其中可能改了东西的（lib/autopilot-tools.ts：只读工具、只读 shell 以外的都算） */
  mutating: number;
  /** 撞额度那句原文（带重置时间）；没撞 = 不填 */
  rateLimitText?: string;
  /** 看到那句话的时刻（重置时间按它解析） */
  rateLimitAt?: number;
  /** 额度闸（bridge/quota-wall.ts）给的重置时刻：整机撞墙时以它为准，比这一轮自己的原文全（几个 agent 的撞墙并过） */
  wallUntil?: number;
  /** API 报错原文，或 bridge 判定的失败原因（超时、agent 掉线） */
  failure?: string;
  /** 本轮发出的带按钮消息数：只认 run 开始之后 agent 自己发的，owner 早先没答的按钮不算 */
  buttonsSent: number;
  /** 回合结束时还挂着的 AskUserQuestion */
  questionOpen: boolean;
  /** 这一轮中途有人插话（人工消息和推进混在同一个回合里） */
  humanInterleaved: boolean;
  /** bridge 在 run 进行中重启过：之前的证据只在内存里，丢了 */
  evidenceLost?: boolean;
}

export const emptyEvidence = (): RunEvidence => ({ tools: 0, mutating: 0, buttonsSent: 0, questionOpen: false, humanInterleaved: false });

/**
 * 归类，优先级从上到下：额度 > 失败 > 在等人 > 干了活 > 正常。
 * 发了按钮但同时也干了别的活，算 action_taken（提醒里要求「拍板的事记下来先跳过」，它照做了就不该停等）；
 * 没干活只发了按钮，或者回合收在一个没答的提问上，才是 blocked_approval。
 */
export function classifyRun(ev: RunEvidence): { outcome: RunOutcome; reason: string } {
  if (ev.rateLimitText) return { outcome: "rate_limited", reason: ev.rateLimitText.slice(0, 160) };
  if (ev.failure) return { outcome: "failed", reason: ev.failure.slice(0, 160) };
  if (ev.questionOpen) return { outcome: "blocked_approval", reason: "回合停在一个没回答的提问上" };
  if (ev.buttonsSent > 0 && ev.mutating === 0) return { outcome: "blocked_approval", reason: `发了 ${ev.buttonsSent} 条带按钮的消息，等人拍板` };
  if (ev.mutating > 0) return { outcome: "action_taken", reason: `调了 ${ev.tools} 个工具，其中 ${ev.mutating} 个可能改了东西` };
  return { outcome: "normal", reason: ev.tools ? `只做了查看（${ev.tools} 个只读调用）` : "没调工具" };
}

// ── 下一次什么时候醒 ──

/** 调参集中在这里（PM 09-28：先按执行者定的来，集中成常量方便以后调） */
export const AUTOPILOT_TIMING = {
  /** 连续几轮 normal（没有写操作；只读查看、回一句话都算没进展）进待命退避：没事做了就 standby */
  idleRunsBeforeStandby: 3,
  standbyStepsMs: [5, 15, 30, 60].map((m) => m * MINUTE_MS),
  /** 额度：解析不出重置时间时等多久；解析出来的再多等一会儿，别卡在重置那一秒 */
  rateLimitFallbackMs: 30 * MINUTE_MS,
  rateLimitSlackMs: 2 * MINUTE_MS,
  /** 在等人拍板：有人答了 / 说话了会提前放行，最多等这么久再看一次 */
  blockedMaxWaitMs: 60 * MINUTE_MS,
  /** 失败退避：1 → 5 → 15 分钟，再往后每小时一次 */
  failStepsMs: [1, 5, 15].map((m) => m * MINUTE_MS),
  failSteadyMs: 60 * MINUTE_MS,
  /** 人类消息后多久内不推进；排队超过多久记一条「未推进」 */
  humanQuietMs: 2 * MINUTE_MS,
  maxYieldDelayMs: 30 * MINUTE_MS,
  /** 让位 / 离线时多久再看一次 */
  yieldRecheckMs: MINUTE_MS,
  /** 投递之后等不到回合结束多久判失败（agent 空闲却没有 done：事件丢了或 agent 挂了） */
  runStaleMs: 30 * MINUTE_MS,
  /** 领到了却一直没标「已投递」：进程在领取和投递之间挂了，过这么久放回队列（不能太短：投递本身可能要等抢占收尾） */
  claimStaleMs: 2 * MINUTE_MS,
} as const;

/**
 * 唤醒被挡住的原因。新的回合结束合并进来时：rate_limit / failed 不提前（额度和故障不会因为人聊了一句就好），
 * blocked / standby 提前（有人答了、说话了，就是有新事做了）。
 */
export type WakeHold = "rate_limit" | "failed" | "blocked" | "standby";

export interface RunStreaks {
  /** 连续 normal（没有写操作）的轮数 */
  idle: number;
  /** 连续失败的轮数 */
  fail: number;
}

/** 证据丢了的一轮（bridge 重启过）说明不了有没有进展：两个计数都原样保留 */
export function nextStreaks(prev: RunStreaks, outcome: RunOutcome, ev: RunEvidence): RunStreaks {
  if (ev.evidenceLost) return { ...prev };
  return { idle: outcome === "normal" ? prev.idle + 1 : 0, fail: outcome === "failed" ? prev.fail + 1 : 0 };
}

export interface NextWake {
  delayMs: number;
  hold?: WakeHold;
  why: string;
}

export function nextWake(outcome: RunOutcome, streaks: RunStreaks, ev: RunEvidence, now: number, graceMs: number): NextWake {
  const T = AUTOPILOT_TIMING;
  if (outcome === "rate_limited") {
    const at = ev.wallUntil ?? (ev.rateLimitText ? parseResetAt(ev.rateLimitText, ev.rateLimitAt ?? now) : null);
    if (at === null) return { delayMs: T.rateLimitFallbackMs, hold: "rate_limit", why: "撞额度，没解析出重置时间" };
    return { delayMs: Math.max(at - now, 0) + T.rateLimitSlackMs, hold: "rate_limit", why: `撞额度，${new Date(at).toISOString()} 重置` };
  }
  if (outcome === "failed") {
    const n = streaks.fail;
    const delayMs = n > T.failStepsMs.length ? T.failSteadyMs : T.failStepsMs[Math.max(n - 1, 0)];
    return { delayMs, hold: "failed", why: `连续失败 ${n} 次` };
  }
  if (outcome === "blocked_approval") return { delayMs: T.blockedMaxWaitMs, hold: "blocked", why: "等人拍板" };
  if (outcome === "normal" && streaks.idle >= T.idleRunsBeforeStandby) {
    const i = Math.min(streaks.idle - T.idleRunsBeforeStandby, T.standbyStepsMs.length - 1);
    return { delayMs: T.standbyStepsMs[i], hold: "standby", why: `连续 ${streaks.idle} 轮没事做，待命` };
  }
  return { delayMs: graceMs, why: outcome === "action_taken" ? "干了活，接着推" : "正常一轮，接着推" };
}

// ── 让位（人优先） ──

export type YieldReason = "quota_wall" | "turn_busy" | "human_recent" | "agent_offline";
export const YIELD_TEXT: Record<YieldReason, string> = {
  quota_wall: "额度闸开着（整机撞额度），出闸后再推进",
  turn_busy: "主回合在跑（有人在对话，或它自己还在干）",
  human_recent: "刚收到人类消息",
  agent_offline: "agent 不在线",
};

/** 该不该先不推进：额度闸开着、主回合在跑、人刚说过话、agent 不在线，任一条都排队等；null = 可以推进 */
export function yieldReason(s: { turnBusy: boolean; online: boolean; lastHumanAt?: number; walled?: boolean }, now: number): YieldReason | null {
  if (s.walled) return "quota_wall"; // 推进消息投过去也只会被闸押住，还白占一个 run
  if (!s.online) return "agent_offline";
  if (s.turnBusy) return "turn_busy";
  if (s.lastHumanAt !== undefined && now - s.lastHumanAt < AUTOPILOT_TIMING.humanQuietMs) return "human_recent";
  return null;
}

// ── 额度重置时间 ──
// 墙上时间 → 时间戳（时区、跨年、夏令时、只有时刻时取哪一天）统一走 lib/usage-window.ts 的 parseResetText，
// 额度闸（lib/quota-wall-text.ts）用的也是它；这里只负责从原文里找出那段时间。

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
/** Claude Code：「resets 2am (Asia/Shanghai)」「resets 4:40pm (Asia/Tokyo)」「resets Oct 3, 2am (Asia/Tokyo)」 */
const CC_RESET = /\bresets\s+(.+)/i;
/** Codex：「try again at 8:41 AM」「try again at Sep 29th, 2026 8:41 AM」（本机时区） */
const CODEX_AT = new RegExp(`try again at\\s+(?:${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\s+)?(\\d{1,2}):(\\d{2})\\s*(am|pm)`, "i");
/** Codex 旧写法：「try again in 2 hours 13 minutes」「try again in 3 days 1 hour」 */
const CODEX_IN = /try again in\s+((?:\d+\s+(?:days?|hours?|minutes?|mins?|seconds?|secs?)[,\s]*(?:and\s+)?)+)/i;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: MINUTE_MS, s: 1000 };
/** 重置时间只信 8 天以内：周额度最长一周，更远的多半是解析错 */
const RESET_HORIZON_MS = 8 * 86_400_000;
/** 刚过去几分钟的重置照样算（马上就该醒，按余量等），更早的是认错了 */
const RESET_PAST_SLACK_MS = 5 * MINUTE_MS;

const plausible = (t: number | null, now: number): number | null =>
  t !== null && t >= now - RESET_PAST_SLACK_MS && t - now <= RESET_HORIZON_MS ? t : null;

/**
 * 撞额度那句话里的重置时刻（时间戳）；CC 和 Codex 的几种写法都认，全都认不出 → null。
 * now 要传「看到那句话的时刻」，不是收尾时刻：收尾晚了几分钟，按收尾时刻算会把刚过去的重置当成认错。
 */
export function parseResetAt(text: string, now: number): number | null {
  const cc = CC_RESET.exec(text);
  if (cc) return plausible(parseResetText(cc[1], now), now);
  const at = CODEX_AT.exec(text);
  if (at) {
    const [, mon, day, year, hh, mm, ap] = at;
    if (!mon) return plausible(parseResetText(`${hh}:${mm}${ap}`, now), now); // 只有时刻：本机时区，取将来最近的那次
    const h = (Number(hh) % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
    return plausible(new Date(Number(year), MONTHS.indexOf(mon.toLowerCase().slice(0, 3)), Number(day), h, Number(mm)).getTime(), now);
  }
  const rel = CODEX_IN.exec(text);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s+([a-z])/gi)) ms += Number(n) * (UNIT_MS[unit.toLowerCase()] ?? 0);
    return ms > 0 && ms <= RESET_HORIZON_MS ? now + ms : null;
  }
  return null;
}
