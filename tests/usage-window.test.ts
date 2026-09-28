/**
 * 用量「本周」的周期起点（src/lib/usage-window.ts）：与周额度条同一口径，拿不到重置时刻退回滚动 7 天。
 * 起因：旧实现按 ISO 周从周一 00:00 算，周一那天「本周」和「今日」一模一样（owner 2026-09-28）。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { currentUsageWindow, parseResetText, weekCycleStart, windowsFor, WEEK_MS } from "../src/lib/usage-window.js";

const H = 3600_000;
// 2026-09-28 17:00 JST（周一）；周重置 2026-09-30 06:00 JST（statusline 的 weekResets = 1790715600 秒）
const NOW = Date.parse("2026-09-28T17:00:00+09:00");
const RESET = 1790715600 * 1000;

describe("weekCycleStart", () => {
  test("重置在未来：起点 = 重置 − 168h（09-23 06:00），不是周一 00:00", () => {
    const w = weekCycleStart(NOW, RESET);
    expect(w).toEqual({ start: Date.parse("2026-09-23T06:00:00+09:00"), source: "quota" });
  });

  test("没有重置时刻：滚动 7 天（按 5 分钟取整，给缓存键用）", () => {
    const w = weekCycleStart(NOW + 123_456, null);
    expect(w.source).toBe("rolling");
    expect(w.start % 300_000).toBe(0);
    expect(NOW + 123_456 - WEEK_MS - w.start).toBeLessThan(300_000);
  });

  test("重置已过（缓存停在旧周期）：起点取旧重置时刻；过去一周以上 → 滚动", () => {
    expect(weekCycleStart(RESET + 2 * H, RESET)).toEqual({ start: RESET, source: "quota" });
    expect(weekCycleStart(RESET + WEEK_MS + H, RESET).source).toBe("rolling");
  });

  test("不可能的重置时刻（一周以后）→ 滚动", () => {
    expect(weekCycleStart(NOW, NOW + WEEK_MS + H).source).toBe("rolling");
  });

  test("按绝对毫秒算，与本机时区 / 夏令时无关：跨 DST 的一周仍是整 168h", () => {
    const reset = Date.parse("2026-11-05T10:00:00Z"); // 美国 11-01 结束夏令时，窗口跨过它
    expect(reset - weekCycleStart(reset - H, reset).start).toBe(168 * H);
  });
});

describe("parseResetText（/status 面板文字，没配 statusline 时的次来源）", () => {
  test("带日期与 IANA 时区", () => {
    expect(parseResetText("Sep 30, 6am (Asia/Tokyo)", NOW)).toBe(RESET);
    expect(parseResetText("Sep 30 at 6:00am (Asia/Tokyo)", NOW)).toBe(RESET);
    expect(parseResetText("Sep 29, 11pm (Asia/Singapore)", NOW)).toBe(Date.parse("2026-09-29T23:00:00+08:00"));
  });

  test("跨时区：同一墙上时间在不同时区换算成不同的绝对时刻", () => {
    const ny = parseResetText("Oct 2, 5pm (America/New_York)", NOW)!;
    expect(ny).toBe(Date.parse("2026-10-02T17:00:00-04:00"));
  });

  test("DST 切换日：美东 11-01 起回到 EST（-05:00）", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(parseResetText("Nov 2, 6am (America/New_York)", now)).toBe(Date.parse("2026-11-02T06:00:00-05:00"));
    expect(parseResetText("Oct 31, 6am (America/New_York)", now)).toBe(Date.parse("2026-10-31T06:00:00-04:00"));
  });

  test("跨年：12 月底看到 Jan 2 → 取下一年", () => {
    const now = Date.parse("2026-12-30T12:00:00Z");
    expect(parseResetText("Jan 2, 6am (UTC)", now)).toBe(Date.parse("2027-01-02T06:00:00Z"));
  });

  test("只有时刻：取将来最近的那次，不选已经过去的昨天同一时刻", () => {
    // now = 09-28 17:00 JST
    expect(parseResetText("11pm (Asia/Tokyo)", NOW)).toBe(Date.parse("2026-09-28T23:00:00+09:00"));
    // 今天 05:00（已过 12h）与明天 05:00（12h 后）离 now 一样近，旧的「取最近」会选中已过去的今天：必须取明天
    expect(parseResetText("5am (Asia/Tokyo)", NOW)).toBe(Date.parse("2026-09-29T05:00:00+09:00"));
    // 刚过几分钟（面板还没刷新）：容差内仍取这一次
    expect(parseResetText("4:58pm (Asia/Tokyo)", NOW)).toBe(Date.parse("2026-09-28T16:58:00+09:00"));
  });

  test("认不出 / 时区名不认识 / 离谱日期", () => {
    expect(parseResetText("", NOW)).toBeNull();
    expect(parseResetText("soon", NOW)).toBeNull();
    expect(parseResetText("Foo 30, 6am", NOW)).toBeNull();
    expect(parseResetText("Mar 3, 6am (UTC)", NOW)).toBeNull(); // 离现在半年，不可能是周重置
    // 时区名不认识：按本机时区解释，不抛
    expect(typeof parseResetText("Sep 30, 6am (Mars/Olympus)", NOW)).toBe("number");
  });
});

describe("currentUsageWindow", () => {
  const cacheFile = (obj: object) => {
    const p = join(mkdtempSync(join(tmpdir(), "usage-window-")), "usage-cache.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  test("statusline 缓存（即使过期）优先", () => {
    const p = cacheFile({ weekPct: 79, weekResets: 1790715600, scrapedAt: NOW - 5 * H });
    const w = currentUsageWindow(NOW, "", p);
    expect(w).toEqual({
      dayStart: new Date(new Date(NOW).setHours(0, 0, 0, 0)).getTime(),
      weekStart: RESET - WEEK_MS,
      weekSource: "quota",
    });
  });

  test("没有缓存 → /status 文字 → 都没有就滚动", () => {
    const missing = join(tmpdir(), "no-such-dir-usage-window", "usage-cache.json");
    expect(currentUsageWindow(NOW, "Sep 30, 6am (Asia/Tokyo)", missing).weekStart).toBe(RESET - WEEK_MS);
    expect(currentUsageWindow(NOW, "", missing).weekSource).toBe("rolling");
  });
});

describe("windowsFor", () => {
  test("周期起点晚于今天 00:00（今天刚重置）：今日与本周各判各的", () => {
    const day = 100, week = 160;
    expect(windowsFor(120, day, week, "today", "week")).toEqual(["today"]);
    expect(windowsFor(170, day, week, "today", "week")).toEqual(["week", "today"]);
    expect(windowsFor(90, day, week, "today", "week")).toEqual([]);
  });
});
