/**
 * i28-Q1 本周已用（src/lib/quota-week.ts）：只取周窗口、整数百分比夹 0..100、过了重置时刻不给、读失败给空（不抛）、60 秒缓存；
 * 借入方内存里的 peer 上报：不带 quota 的 hello 清掉旧数、一小时没更新不再给、单家过了重置时刻只少那一家。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { localWalled, notePeerQuota, peerQuota, readWeekQuota, reportOf, resetWeekQuotaCacheForTest, weekOf } from "../src/lib/quota-week.js";

const NOW = 1_000_000_000;
const DAY = 86_400_000;
const q = (windows: InventoryQuota["windows"]): InventoryQuota => ({ status: "known", source: "live", observedAt: NOW, plan: "pro", windows, reason: null });
const win = (kind: string, usedPct: number | null, resetsAtMs: number | null) => ({ id: kind === "weekly" ? "7d" : "5h", kind, usedPct, resetsAtMs, resetPassed: false });

beforeEach(() => resetWeekQuotaCacheForTest());

describe("weekOf / reportOf", () => {
  test("只取 weekly 窗口：5 小时窗口、按模型的周窗口都不算", () => {
    expect(weekOf(q([win("session", 90, NOW + 1000), win("weekly", 41.6, NOW + DAY)]), NOW)).toEqual({ weekUsedPct: 42, resetAt: NOW + DAY });
    expect(weekOf(q([win("session", 90, NOW + 1000), win("weekly_scoped", 10, NOW + DAY)]), NOW)).toBeNull();
  });
  test("百分比未知、没有重置时刻、已过重置时刻 → null；越界夹到 0..100", () => {
    expect(weekOf(q([win("weekly", null, NOW + DAY)]), NOW)).toBeNull();
    expect(weekOf(q([win("weekly", 5, null)]), NOW)).toBeNull();
    expect(weekOf(q([win("weekly", 5, NOW)]), NOW)).toBeNull();
    expect(weekOf(q([win("weekly", 130, NOW + DAY)]), NOW)!.weekUsedPct).toBe(100);
    expect(weekOf(q([win("weekly", -3, NOW + DAY)]), NOW)!.weekUsedPct).toBe(0);
  });
  test("报告里只有两个字段（不带 plan / source / 账户）；读不到的那家不出现", () => {
    const r = reportOf({ codex: q([win("weekly", 18, NOW + DAY)]), claude: { ...q([]), status: "unknown", reason: "没有" } }, NOW);
    expect(r).toEqual({ codex: { weekUsedPct: 18, resetAt: NOW + DAY } });
    expect(Object.keys(r.codex!).sort()).toEqual(["resetAt", "weekUsedPct"]);
  });
});

describe("readWeekQuota", () => {
  test("读失败给空对象，不抛；成功后 60 秒内走缓存，过了再读", async () => {
    expect(await readWeekQuota(NOW, async () => { throw new Error("坏了"); })).toEqual({});
    let reads = 0;
    const read = async () => (reads++, { codex: q([win("weekly", 20, NOW + DAY)]), claude: q([]) });
    expect(await readWeekQuota(NOW, read)).toEqual({ codex: { weekUsedPct: 20, resetAt: NOW + DAY } });
    await readWeekQuota(NOW + 59_000, read);
    expect(reads).toBe(1);
    await readWeekQuota(NOW + 61_000, read);
    expect(reads).toBe(2);
  });
  test("缓存里的值过了重置时刻就不给", async () => {
    await readWeekQuota(NOW, async () => ({ codex: q([win("weekly", 20, NOW + 10_000)]), claude: q([]) }));
    expect(await readWeekQuota(NOW + 20_000, async () => { throw new Error("不该读"); })).toEqual({});
  });
});

describe("peer 上报（借入方内存）", () => {
  test("记下、读回；hello 不带 quota 就清掉；一小时没更新不给；单家过重置只少那一家", () => {
    notePeerQuota("mate", { codex: { weekUsedPct: 5, resetAt: NOW + DAY }, claude: { weekUsedPct: 9, resetAt: NOW + 1000 } }, NOW);
    expect(peerQuota("mate", NOW)).toEqual({ codex: { weekUsedPct: 5, resetAt: NOW + DAY }, claude: { weekUsedPct: 9, resetAt: NOW + 1000 } });
    expect(peerQuota("mate", NOW + 2000)).toEqual({ codex: { weekUsedPct: 5, resetAt: NOW + DAY } });
    expect(peerQuota("mate", NOW + 3_600_001)).toBeNull();
    notePeerQuota("mate", undefined, NOW);
    expect(peerQuota("mate", NOW)).toBeNull();
    expect(peerQuota("ghost", NOW)).toBeNull();
  });
});

describe("localWalled", () => {
  test("文件不在 / 坏了 = false；有墙没退出 = true；已退出 = false", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-week-"));
    const p = join(dir, "quota-wall.json");
    expect(localWalled(p)).toBe(false);
    writeFileSync(p, "{");
    expect(localWalled(p)).toBe(false);
    writeFileSync(p, JSON.stringify({ v: 1, wall: null }));
    expect(localWalled(p)).toBe(false);
    writeFileSync(p, JSON.stringify({ v: 1, wall: { enteredAt: NOW, hits: {} } }));
    expect(localWalled(p)).toBe(true);
    writeFileSync(p, JSON.stringify({ v: 1, wall: { enteredAt: NOW, hits: {}, exit: { at: NOW + 1, via: "cli" } } }));
    expect(localWalled(p)).toBe(false);
  });
});
