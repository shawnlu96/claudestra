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
import { parseUsageCache } from "../src/lib/usage-cache.ts";

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
  test("过期缓存：不抓取，给陈旧推算值并标 stale；过了重置时刻的窗口归零是推算，不是未知", () => {
    const old = cacheJson(2 * 3600_000, { sessionResets: Math.floor((NOW - 60_000) / 1000) });
    const p = paths(old);
    expect(usageCacheHealth(NOW, p.cache)).toBe("stale");
    const u = readAccountUsageView(NOW, p);
    expect(u).toMatchObject({ source: "statusline", stale: true, reason: "expired", weekPct: 77, sessionPct: 0, raw: "statusline cache (stale)" });
  });
  test("手动读数比缓存新 → 用手动读数（source manual），缓存比它新 → 用缓存并沿用 cost", () => {
    const manual = { sessionPct: 50, weekPct: 60, sessionResets: "7pm", weekResets: "", totalCost: "1.00", apiDuration: null, scrapedAt: NOW - 1000 };
    const st = { lastAttemptAt: null, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null, inFlight: null, lastReading: manual };
    expect(readAccountUsageView(NOW, paths(cacheJson(60_000), st))).toMatchObject({ source: "manual", sessionPct: 50, stale: false });
    const older = { ...st, lastReading: { ...manual, scrapedAt: NOW - 3600_000 } };
    expect(readAccountUsageView(NOW, paths(cacheJson(60_000), older))).toMatchObject({ source: "statusline", sessionPct: 22, totalCost: "1.00" });
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
