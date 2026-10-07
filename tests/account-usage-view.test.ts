/**
 * 后台读账号用量（lib/account-usage-view.ts）：缓存缺失 / 损坏 / 过期都不回退抓取，显示未知或原读数 + 时间 / source / stale；
 * 未知是 null 不是 0。额度消费者（quota-layers）拿到缺字段的缓存也不伪装成 0。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccountUsageView, usageCacheHealth } from "../src/lib/account-usage-view.ts";
import { selectQuotaLayers } from "../src/lib/quota-layers.ts";
import { parseUsageCache, readUsageCacheStale } from "../src/lib/usage-cache.ts";

const dir = mkdtempSync(join(tmpdir(), "acct-view-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const NOW = 1_787_798_183_000;
let n = 0;
function paths(cache?: string, refresh?: unknown) {
  const p = { cache: join(dir, `cache-${n}.json`), refresh: join(dir, `refresh-${n++}.json`) };
  if (cache !== undefined) writeFileSync(p.cache, cache);
  if (refresh !== undefined) writeFileSync(p.refresh, JSON.stringify(refresh));
  return p;
}
const cacheJson = (ageMs: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ sessionPct: 22, weekPct: 77, sessionResets: Math.floor((NOW + 3600_000) / 1000), weekResets: Math.floor((NOW + 86400_000) / 1000),
    scrapedAt: NOW - ageMs, source: "statusline", ...extra });

describe("readAccountUsageView", () => {
  test("缓存缺失 → 未知（null，不是 0），source none", () => {
    const u = readAccountUsageView(NOW, paths());
    expect(u.sessionPct).toBeNull();
    expect(u.weekPct).toBeNull();
    expect(u.source).toBe("none");
    expect(u.scrapedAt).toBe(0);
    expect(u.reason).toBe("missing");
  });
  test("缓存损坏 → 未知，reason corrupt", () => {
    const p = paths("{bad");
    expect(usageCacheHealth(NOW, p.cache)).toBe("corrupt");
    const u = readAccountUsageView(NOW, p);
    expect(u.sessionPct).toBeNull();
    expect(u.reason).toBe("corrupt");
  });
  test("新鲜缓存：原读数 + 毫秒观测时刻，resets 的 Unix 秒照旧换算（时间单位共存）", () => {
    const u = readAccountUsageView(NOW, paths(cacheJson(60_000)));
    expect(u).toMatchObject({ sessionPct: 22, weekPct: 77, source: "statusline", stale: false, scrapedAt: NOW - 60_000, raw: "statusline cache" });
    expect(u.sessionResets).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/);
  });
  test("过期缓存：不抓取、不推算——原真实读数（含已过的重置时间）+ 观测时刻 + stale，不把 84% 改成没观测过的 0%", () => {
    const old = cacheJson(3600_000, { sessionPct: 84, sessionResets: Math.floor((NOW - 60_000) / 1000) });
    const p = paths(old);
    expect(usageCacheHealth(NOW, p.cache)).toBe("stale");
    const u = readAccountUsageView(NOW, p);
    expect(u).toMatchObject({ source: "statusline", stale: true, reason: "expired", weekPct: 77, sessionPct: 84, scrapedAt: NOW - 3600_000, raw: "statusline cache (stale)" });
    expect(u.sessionResets).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/);
  });
  test("手动读数比缓存新 → 用手动读数（source manual），缓存比它新 → 用缓存并沿用 cost", () => {
    const manual = { sessionPct: 50, weekPct: 60, sessionResets: "7pm", weekResets: "", totalCost: "1.00", apiDuration: null, scrapedAt: NOW - 1000 };
    const st = { lastAttemptAt: null, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null, inFlight: null, lastReading: manual };
    expect(readAccountUsageView(NOW, paths(cacheJson(60_000), st))).toMatchObject({ source: "manual", sessionPct: 50, stale: false });
    const older = { ...st, lastReading: { ...manual, scrapedAt: NOW - 3600_000 } };
    expect(readAccountUsageView(NOW, paths(cacheJson(60_000), older))).toMatchObject({ source: "statusline", sessionPct: 22, totalCost: "1.00" });
  });
});

describe("复现 manual-cache-shape：手动读数字段级校验", () => {
  const good = { sessionPct: 40, weekPct: 50, sessionResets: "3pm", weekResets: "Oct 9", totalCost: null, apiDuration: null };
  const state = (lastReading: unknown) => ({ lastAttemptAt: NOW, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null, inFlight: null, lastReading });
  const bad: [string, Record<string, unknown>][] = [
    ["百分比是字符串 / 负数 / 数字重置时间", { sessionPct: "broken", weekPct: -5, sessionResets: 12 }],
    ["百分比超出 0-100", { sessionPct: 140 }],
    ["百分比非有限数（字符串 NaN）", { weekPct: "NaN" }],
    ["重置时间是数字", { weekResets: 99 }],
    ["观测时刻不是有限正数", { scrapedAt: "now" }],
    ["观测时刻在未来", { scrapedAt: NOW + 3600_000 }],
    ["cost 类型错", { totalCost: 3 }],
  ];
  for (const [name, patch] of bad) {
    test(`${name}：没有缓存 → 明确未知，不当新鲜手动读数`, () => {
      const u = readAccountUsageView(NOW, paths(undefined, state({ ...good, scrapedAt: NOW - 1000, ...patch })));
      expect(u.source).toBe("none");
      expect(u.sessionPct).toBeNull();
      expect(u.weekPct).toBeNull();
    });
    test(`${name}：有有效缓存 → 退回缓存，不被坏手动读数覆盖`, () => {
      const p = paths(cacheJson(60_000), state({ ...good, scrapedAt: NOW - 1000, ...patch }));
      const u = readAccountUsageView(NOW, p);
      expect(u.source).toBe("statusline");
      expect(u.sessionPct).toBe(22);
      expect(readUsageCacheStale(NOW, p.cache, p.refresh)?.sessionPct).toBe(22);
    });
  }
  test("合法手动读数照常生效（null 百分比 = 未知也合法）", () => {
    const u = readAccountUsageView(NOW, paths(undefined, state({ ...good, weekPct: null, scrapedAt: NOW - 1000 })));
    expect(u).toMatchObject({ source: "manual", sessionPct: 40, weekPct: null, stale: false });
  });
});

describe("额度消费者：未知不伪装 0", () => {
  test("缓存缺 weekPct：quota-layers 的本机条目 used 为 null", () => {
    const c = parseUsageCache(JSON.stringify({ sessionPct: 10, scrapedAt: NOW - 1000 }), NOW, Infinity);
    const snap = selectQuotaLayers({ now: NOW, enabled: false, remote: null, local: { claudeCache: c, codexRollout: null } });
    const meters = snap.providers.flatMap((p) => p.meters);
    const weekly = meters.find((m) => m.kind === "weekly");
    if (weekly) expect(weekly.used).toBeNull();
    expect(meters.some((m) => m.used === 0)).toBe(false);
  });
  test("没有缓存：不出本机 Claude 读数（不是一条 0%）", () => {
    const snap = selectQuotaLayers({ now: NOW, enabled: false, remote: null, local: { claudeCache: null, codexRollout: null } });
    expect(snap.providers.flatMap((p) => p.meters).some((m) => m.used === 0)).toBe(false);
  });
});

describe("额度服务的本机读数 = 同一份最新真实读数（readUsageCacheStale）", () => {
  const st = (lastReading: unknown) => ({ lastAttemptAt: null, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null, inFlight: null, lastReading });
  const manual = { sessionPct: 77, weekPct: 34, sessionResets: "7pm", weekResets: "Oct 9", totalCost: null, apiDuration: null, scrapedAt: NOW - 1000 };
  test("手动读数比缓存新：额度层本机 Claude 用手动读数（77，不是缓存的 12），同窗口沿用缓存的重置时刻", () => {
    const p = paths(cacheJson(60_000, { sessionPct: 12 }), st(manual));
    const c = readUsageCacheStale(NOW, p.cache, p.refresh)!;
    expect(c).toMatchObject({ sessionPct: 77, weekPct: 34, scrapedAt: NOW - 1000, sessionResetsAtMs: NOW + 3600_000 });
    expect(readAccountUsageView(NOW, p).sessionPct).toBe(77);
    const snap = selectQuotaLayers({ now: NOW, enabled: false, remote: null, local: { claudeCache: c, codexRollout: null } });
    expect(snap.providers.flatMap((x) => x.meters).find((m) => m.kind === "session")?.used).toBe(77);
  });
  test("没有 statusline 缓存：额度层也有手动读数；缓存更新则用缓存", () => {
    const p = paths(undefined, st(manual));
    expect(readUsageCacheStale(NOW, p.cache, p.refresh)).toMatchObject({ sessionPct: 77, sessionResetsAtMs: null, scrapedAt: NOW - 1000 });
    const q = paths(cacheJson(10, { sessionPct: 12 }), st(manual));
    expect(readUsageCacheStale(NOW, q.cache, q.refresh)?.sessionPct).toBe(12);
  });
  test("过期缓存原样返回观测值（不推算归零）；fixture 缓存路径不跟随真实手动状态", () => {
    const p = paths(cacheJson(3600_000, { sessionPct: 84, sessionResets: Math.floor((NOW - 60_000) / 1000) }));
    expect(readUsageCacheStale(NOW, p.cache)).toMatchObject({ sessionPct: 84, scrapedAt: NOW - 3600_000 });
  });
});
