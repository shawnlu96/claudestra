/**
 * 用量统计的时间窗：「今日」= 本地 00:00 起，「本周」= **当前周额度周期**（与看板上的周额度条同一口径）。
 *
 * 周期起点 = 周重置时刻 − 168h（绝对毫秒，与本机时区、夏令时无关）。重置时刻的来源依次是：
 *   1. statusline 缓存的 weekResets（Unix 秒，最准；过期的缓存照样可用，重置时刻不会因为没人用而变）
 *   2. /status 面板抓下来的文字（"Sep 30, 6am (Asia/Tokyo)"），没配 statusline 的安装走这条
 *   3. 都拿不到 → 滚动 7 天，展示层据 weekSource 写「近 7 天」而不是假装知道周期起点
 * 单测 tests/usage-window.test.ts。
 */

import { readUsageCacheStale, USAGE_CACHE_PATH } from "./usage-cache.js";

export const WEEK_MS = 7 * 24 * 3600_000;

export interface UsageWindowBounds {
  /** 今天本地 00:00（ms） */
  dayStart: number;
  /** 本周统计起点（ms） */
  weekStart: number;
  /** quota = 按周额度周期；rolling = 拿不到重置时刻，滚动 7 天 */
  weekSource: "quota" | "rolling";
}

/** 今天本地 00:00 的 ms 时间戳 */
function dayStartTs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 周重置时刻 → 当前周期起点。
 * 重置已过（缓存停在旧周期）：新周期从过点之后的首次使用算起，其间没有消耗，所以起点取旧重置时刻即可；
 * 过去超过一周、或重置时刻离现在超过一周（不可能的值）→ 滚动 7 天。
 */
export function weekCycleStart(nowMs: number, resetAtMs: number | null): { start: number; source: "quota" | "rolling" } {
  // 滚动起点按 5 分钟取整：它是 readFileStats 缓存键的一部分，逐毫秒变就永远不命中
  const rolling = { start: Math.floor((nowMs - WEEK_MS) / 300_000) * 300_000, source: "rolling" as const };
  if (resetAtMs === null || !Number.isFinite(resetAtMs)) return rolling;
  if (resetAtMs > nowMs) return resetAtMs - nowMs <= WEEK_MS ? { start: resetAtMs - WEEK_MS, source: "quota" } : rolling;
  return nowMs - resetAtMs < WEEK_MS ? { start: resetAtMs, source: "quota" } : rolling;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** 某 IANA 时区在 utcMs 这一刻相对 UTC 的偏移（ms）；时区不认识返回 null */
function tzOffsetMs(utcMs: number, tz: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(utcMs));
  } catch {
    return null; // RangeError：不认识的时区名，调用方退回本机时区
  }
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour") % 24, v("minute"), v("second"));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** 墙上时间（某时区）→ 绝对毫秒。偏移按结果时刻再算一遍，DST 切换日也落在正确一侧 */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string | null): number {
  if (!tz) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = tzOffsetMs(guess, tz);
  if (off1 === null) return new Date(y, mo, d, h, mi).getTime();
  const off2 = tzOffsetMs(guess - off1, tz) ?? off1;
  return guess - off2;
}

/**
 * /status 面板和撞墙提示的重置文字 → 绝对毫秒。认的形态："Sep 30, 6am (Asia/Tokyo)"、"Sep 30 at 6:30pm"、"Fri 9am (Asia/Tokyo)"、"6am (UTC)"。
 * 带日期不带年份：取离现在最近、且落在 [now − 7d, now + 8d] 内的那一年（周重置不可能更远）。
 * 只有星期 / 只有时刻：重置总在将来，取不早于 now − 5 分钟的最早那个（离得最近的可能是已经过去的昨天同一时刻）。认不出返回 null。
 */
export function parseResetText(text: string, nowMs: number): number | null {
  const m = text.trim().match(/^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?|([A-Za-z]{3,9})\.?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toLowerCase() === "pm") hour += 12;
  const minute = m[5] ? Number(m[5]) : 0;
  const tz = m[7]?.trim() || null;
  const candidates: number[] = [];
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mo < 0) return null;
    const y0 = new Date(nowMs).getFullYear();
    for (const y of [y0 - 1, y0, y0 + 1]) candidates.push(wallToUtc(y, mo, Number(m[2]), hour, minute, tz));
    const ok = candidates.filter((c) => Number.isFinite(c) && c >= nowMs - WEEK_MS && c <= nowMs + WEEK_MS + 24 * 3600_000);
    return ok.length ? ok.sort((a, b) => Math.abs(a - nowMs) - Math.abs(b - nowMs))[0] : null;
  }
  const wd = m[3] ? WEEKDAYS.indexOf(m[3].slice(0, 3).toLowerCase()) : null;
  if (wd === -1) return null;
  // 今天前后几天的那个点（按对方时区的日期推，这里用本机日期加减一天兜住跨日）；带星期的只留那一天
  const d = new Date(nowMs);
  for (let off = -1; off <= (wd === null ? 1 : 7); off++) {
    if (wd !== null && new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + off)).getUTCDay() !== wd) continue;
    candidates.push(wallToUtc(d.getFullYear(), d.getMonth(), d.getDate() + off, hour, minute, tz));
  }
  const upcoming = candidates.filter((c) => Number.isFinite(c) && c >= nowMs - 5 * 60_000).sort((a, b) => a - b);
  return upcoming[0] ?? null;
}

/** 最近一次 /status 面板抓到的周重置文字（没配 statusline 时的次来源）；bridge 抓到就记一笔 */
let lastWeekResetText = "";
export function noteWeekResetText(text: string | null | undefined): void {
  if (text) lastWeekResetText = text;
}

/** 当前的今日 / 本周边界。statusline 缓存 → /status 文字 → 滚动 7 天 */
export function currentUsageWindow(nowMs = Date.now(), resetText = lastWeekResetText, cachePath = USAGE_CACHE_PATH): UsageWindowBounds {
  let resetAt = readUsageCacheStale(nowMs, cachePath)?.weekResetsAtMs ?? null;
  if (resetAt === null && resetText) resetAt = parseResetText(resetText, nowMs);
  const w = weekCycleStart(nowMs, resetAt);
  return { dayStart: dayStartTs(nowMs), weekStart: w.start, weekSource: w.source };
}

/**
 * 一条记录落进哪几个窗口。周期起点可能晚于今天 00:00（今天刚重置过），所以「今日」不是「本周」的子集，
 * 两个窗口各判各的；扫描器的回溯下界是两者中更早的那个（windowFloor）。
 */
export function windowsFor<T>(ts: number, dayTs: number, weekTs: number, today: T, week: T): T[] {
  const out: T[] = [];
  if (ts >= weekTs) out.push(week);
  if (ts >= dayTs) out.push(today);
  return out;
}

export const windowFloor = (dayTs: number, weekTs: number): number => Math.min(dayTs, weekTs);
