/**
 * statusline 用量缓存解析单测(v2.20.1+,peer 方案 2026-08-27)。
 * 关键契约:sessionResets/weekResets 是 Unix 秒(peer 实测补正,不是 ISO),
 * scrapedAt 是毫秒;新鲜度 10min;空壳/坏形态返回 null 让调用方回退抓取。
 */
import { describe, test, expect } from "bun:test";
import { parseUsageCache, formatResetTs } from "../src/lib/usage-cache.js";

const NOW = 1787798183000;

describe("parseUsageCache", () => {
  test("peer 实测格式:Unix 秒 resets + 毫秒 scrapedAt", () => {
    const r = parseUsageCache(
      '{"sessionPct":22,"weekPct":77,"sessionResets":1787810400,"scrapedAt":1787798183000,"source":"statusline"}',
      NOW
    );
    expect(r).not.toBeNull();
    expect(r!.sessionPct).toBe(22);
    expect(r!.weekPct).toBe(77);
    expect(r!.sessionResets).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/);
  });
  test("过期(>10min)返回 null 回退抓取", () => {
    const stale = JSON.stringify({ sessionPct: 22, weekPct: 77, scrapedAt: NOW - 11 * 60 * 1000 });
    expect(parseUsageCache(stale, NOW)).toBeNull();
  });
  test("坏 JSON / 空壳(双 pct 缺失)/ 缺 scrapedAt 都 null", () => {
    expect(parseUsageCache("not json", NOW)).toBeNull();
    expect(parseUsageCache('{"scrapedAt":' + NOW + "}", NOW)).toBeNull();
    expect(parseUsageCache('{"sessionPct":22}', NOW)).toBeNull();
  });
  test("脏 pct(越界/非数)拒收单字段,另一字段仍可用", () => {
    const r = parseUsageCache(
      JSON.stringify({ sessionPct: 150, weekPct: 77, scrapedAt: NOW }),
      NOW
    );
    expect(r!.sessionPct).toBeNull();
    expect(r!.weekPct).toBe(77);
  });
});

describe("formatResetTs", () => {
  test("Unix 秒与 ISO 字符串都认;垃圾返回空串", () => {
    expect(formatResetTs(1787810400)).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/);
    expect(formatResetTs("2026-08-27T06:00:00Z")).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/);
    expect(formatResetTs("garbage")).toBe("");
    expect(formatResetTs(null)).toBe("");
    expect(formatResetTs(42)).toBe(""); // 太小,不是合理的 unix 秒
  });
});
