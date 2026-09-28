/**
 * Autopilot 的单次推进（run）：把一轮的事件证据归成五类结果，再按结果算下一次什么时候醒（纯函数，tests/autopilot-run.test.ts）。
 * 证据来自事件总线（bridge/autopilot-evidence.ts），不靠模型自报：撞额度、API 报错、本轮发出的按钮 / 没答完的提问都是事件。
 * 取代旧的「提醒后 90 秒内结束就算空转 → 5/15/30/60 分钟退避」：那条把额度用尽、在等人、正常很短的一轮混成一类。
 */
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
    const at = ev.rateLimitText ? parseResetAt(ev.rateLimitText, ev.rateLimitAt ?? now) : null;
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

export type YieldReason = "turn_busy" | "human_recent" | "agent_offline" | "human_stopped" | "cut_notice";
export const YIELD_TEXT: Record<YieldReason, string> = {
  turn_busy: "主回合在跑（有人在对话，或它自己还在干）",
  human_recent: "刚收到人类消息",
  agent_offline: "agent 不在线",
  human_stopped: "人叫停了（停字 / 停止按钮 / 终端里打断），等人再开口",
  cut_notice: "还有一条打断收尾提醒没投，先让它处理",
};

/**
 * 该不该先不推进：主回合在跑、人刚说过话、agent 不在线、人叫停了（之后没再说别的）、打断收尾提醒还没投，任一条都排队等；null = 可以推进。
 * interruptHold 来自 bridge/turn-cuts.ts（「停」之后 Autopilot 不能替人续上）。
 */
export function yieldReason(
  s: { turnBusy: boolean; online: boolean; lastHumanAt?: number; interruptHold?: "stopped" | "notice" | null }, now: number,
): YieldReason | null {
  if (!s.online) return "agent_offline";
  if (s.interruptHold === "stopped") return "human_stopped";
  if (s.turnBusy) return "turn_busy";
  if (s.lastHumanAt !== undefined && now - s.lastHumanAt < AUTOPILOT_TIMING.humanQuietMs) return "human_recent";
  return s.interruptHold === "notice" ? "cut_notice" : null;
}

// ── 额度重置时间 ──

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
/** Claude Code：「resets 2am (Asia/Shanghai)」「resets 4:40pm (Asia/Tokyo)」「resets Oct 3, 2am (Asia/Tokyo)」 */
const CC_RESET = new RegExp(`resets\\s+(?:${MONTH_RE}\\s+(\\d{1,2}),?\\s+(?:at\\s+)?)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\s*(?:\\(([^)]+)\\))?`, "i");
/** Codex：「try again at 8:41 AM」「try again at Sep 29th, 2026 8:41 AM」（本机时区） */
const CODEX_AT = new RegExp(`try again at\\s+(?:${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\s+)?(\\d{1,2}):(\\d{2})\\s*(am|pm)`, "i");
/** Codex 旧写法：「try again in 2 hours 13 minutes」「try again in 3 days 1 hour」 */
const CODEX_IN = /try again in\s+((?:\d+\s+(?:days?|hours?|minutes?|mins?|seconds?|secs?)[,\s]*(?:and\s+)?)+)/i;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: MINUTE_MS, s: 1000 };
/** 重置时间只信 8 天以内：周额度最长一周，更远的多半是解析错 */
const RESET_HORIZON_MS = 8 * 86_400_000;

/** 某时区的「墙上时间」→ 时间戳；tz 为空 = 本机时区。时区名认不出（RangeError）同样按本机算，差几个小时也比退回 30 分钟准 */
function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  try {
    const guess = Date.UTC(y, mo, d, h, mi);
    const t = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(t, tz); // 用目标时刻的偏移再校一次，跨夏令时那天不差一小时
  } catch {
    return new Date(y, mo, d, h, mi).getTime();
  }
}

function tzParts(epoch: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour, mi: p.minute };
}

function tzOffsetMs(epoch: number, tz: string): number {
  const p = tzParts(epoch, tz);
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - Math.floor(epoch / MINUTE_MS) * MINUTE_MS;
}

/** 该时区里「今天」的年月日；tz 认不出同样退回本机 */
function todayIn(now: number, tz?: string): { y: number; mo: number; d: number } {
  if (tz) {
    try {
      return tzParts(now, tz);
    } catch {
      // 时区名认不出：和 wallToEpoch 一样按本机算
    }
  }
  const n = new Date(now);
  return { y: n.getFullYear(), mo: n.getMonth(), d: n.getDate() };
}

const to24 = (h: number, ap: string): number => (h % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);

/**
 * 只有时刻没有日期：取该时区今天的这个时刻，已过就算明天。有月日没有年：今年的这天已过就算明年。
 * now 要传「看到那句话的时刻」，不是收尾时刻：收尾晚了几分钟，按收尾时刻算会把刚过去的重置滚到明天。
 * 结果不在 (now-1 分钟, now+8 天) 之内 → null，调用方退回固定等待。
 */
function resolveWall(now: number, h: number, mi: number, tz: string | undefined, md?: { mo: number; d: number; y?: number }): number | null {
  let t: number;
  if (md) {
    const y = md.y ?? todayIn(now, tz).y;
    t = wallToEpoch(y, md.mo, md.d, h, mi, tz);
    if (md.y === undefined && t < now - MINUTE_MS) t = wallToEpoch(y + 1, md.mo, md.d, h, mi, tz);
  } else {
    const td = todayIn(now, tz);
    t = wallToEpoch(td.y, td.mo, td.d, h, mi, tz);
    if (t < now - MINUTE_MS) t = wallToEpoch(td.y, td.mo, td.d + 1, h, mi, tz);
  }
  return t > now - MINUTE_MS && t - now <= RESET_HORIZON_MS ? t : null;
}

/** 撞额度那句话里的重置时刻（时间戳）；CC 和 Codex 的几种写法都认，全都认不出 → null */
export function parseResetAt(text: string, now: number): number | null {
  const cc = CC_RESET.exec(text);
  if (cc) {
    const [, mon, day, hh, mm, ap, tz] = cc;
    const md = mon ? { mo: MONTHS.indexOf(mon.toLowerCase().slice(0, 3)), d: Number(day) } : undefined;
    return resolveWall(now, to24(Number(hh), ap), Number(mm ?? 0), tz?.trim(), md);
  }
  const at = CODEX_AT.exec(text);
  if (at) {
    const [, mon, day, year, hh, mm, ap] = at;
    const md = mon ? { mo: MONTHS.indexOf(mon.toLowerCase().slice(0, 3)), d: Number(day), y: Number(year) } : undefined;
    return resolveWall(now, to24(Number(hh), ap), Number(mm), undefined, md);
  }
  const rel = CODEX_IN.exec(text);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s+([a-z])/gi)) ms += Number(n) * (UNIT_MS[unit.toLowerCase()] ?? 0);
    return ms > 0 && ms <= RESET_HORIZON_MS ? now + ms : null;
  }
  return null;
}
