/** lib/missions.ts：截止时间解析、空转计数与退避、提醒种类与文案、加锁读改写 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backoffMs, COMPACT_HINT_RATIO, FAST_TURN_MS, missionKey, nextFastTurns, nudgeKind, nudgeText, parseUntil, readMissions, updateMissions, type Mission,
} from "../src/lib/missions.js";

const NOW = new Date(2026, 8, 28, 3, 40, 0); // 本地 03:40
const base = (over: Partial<Mission> = {}): Mission => ({
  agent: "claudestra", goal: "按台账推进", until: new Date(2026, 8, 28, 11, 0).toISOString(), createdAt: NOW.toISOString(),
  status: "active", nudges: 0, fastTurns: 0, ...over,
});

describe("parseUntil", () => {
  test("HH:MM：今天还没到就今天，已过就明天", () => {
    expect(parseUntil("11:00", NOW)?.getTime()).toBe(new Date(2026, 8, 28, 11, 0).getTime());
    expect(parseUntil("03:00", NOW)?.getTime()).toBe(new Date(2026, 8, 29, 3, 0).getTime());
  });
  test("+90m / +3h 相对时间；ISO；7 天外、过去、写错一律 null", () => {
    expect(parseUntil("+90m", NOW)?.getTime()).toBe(NOW.getTime() + 90 * 60_000);
    expect(parseUntil("+3h", NOW)?.getTime()).toBe(NOW.getTime() + 3 * 3_600_000);
    expect(parseUntil(new Date(NOW.getTime() + 3_600_000).toISOString(), NOW)?.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(parseUntil("2026-12-01T00:00:00Z", NOW)).toBeNull();
    expect(parseUntil("2026-09-01T00:00:00Z", NOW)).toBeNull();
    expect(parseUntil("25:00", NOW)).toBeNull();
    expect(parseUntil("明早", NOW)).toBeNull();
  });
});

describe("空转与退避", () => {
  test("提醒后很快就结束的回合 +1，正常干活的回合清零", () => {
    const at = NOW.getTime();
    const m = base({ lastNudgeAt: new Date(at).toISOString(), fastTurns: 1 });
    expect(nextFastTurns(m, at + 20_000)).toBe(2);
    expect(nextFastTurns(m, at + FAST_TURN_MS + 1)).toBe(0);
    expect(nextFastTurns(base(), at)).toBe(0);
  });
  test("连续两次空转才开始等：5 → 15 → 30 → 60 分钟封顶", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 60_000)).toEqual([0, 0, 5, 15, 30, 60, 60]);
  });
});

describe("提醒种类与文案", () => {
  test("到点 → deadline；上下文过线 → compact；其余 continue", () => {
    const m = base();
    expect(nudgeKind(m, Date.parse(m.until), null)).toBe("deadline");
    expect(nudgeKind(m, NOW.getTime(), COMPACT_HINT_RATIO)).toBe("compact");
    expect(nudgeKind(m, NOW.getTime(), 0.3)).toBe("continue");
    expect(nudgeKind(m, NOW.getTime(), null)).toBe("continue");
  });
  test("文案带目标、截止、剩余时间、台账路径与完成命令；到点文案说明已关闭", () => {
    const m = base({ ledger: "~/ledger.json" });
    const t = nudgeText(m, "continue", NOW.getTime(), "bun /r/src/manager.ts mission done claudestra");
    expect(t).toContain("按台账推进");
    expect(t).toContain("截止 11:00（还剩 7 小时 20 分）");
    expect(t).toContain("~/ledger.json");
    expect(t).toContain('`bun /r/src/manager.ts mission done claudestra "<一句话总结>"`');
    expect(nudgeText(m, "compact", NOW.getTime(), "x")).toContain("/save-compact");
    expect(nudgeText(m, "deadline", NOW.getTime(), "x")).toContain("值守已关闭");
  });
  test("missionKey 去掉 agent- 前缀", () => {
    expect(missionKey("agent-claudestra")).toBe("claudestra");
    expect(missionKey("master")).toBe("master");
  });
});

describe("updateMissions", () => {
  test("加锁读改写：不存在时从空开始，返回值带出，写完读得回", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "missions-")), "missions.json");
    const r = await updateMissions((all) => {
      all.claudestra = base();
      return Object.keys(all).length;
    }, path);
    expect(r).toBe(1);
    expect((await readMissions(path)).claudestra.goal).toBe("按台账推进");
  });
});
