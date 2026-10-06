/**
 * 后台读账号用量：网页 GET /stats、Discord 看板（hook / 定时 / 刷新按钮）、doctor 都走这里，**只读缓存，永不碰 TUI**。
 * 来源按观测时刻取新：statusline 落盘缓存（lib/usage-cache.ts）与上次手动探测成功的读数（lib/account-usage-refresh.ts）。
 * 缓存缺失 / 损坏 / 过期都不回退抓取：过期给陈旧推算值并标 stale，都没有就是「未知」（pct 为 null，scrapedAt 0）——
 * 调用方必须把 null 显示成未知，不能当 0。单测 tests/account-usage-view.test.ts。
 */
import { readFileSync } from "fs";
import type { AccountUsage } from "./account-usage-panel.js";
import { ACCOUNT_USAGE_REFRESH_PATH, lastManualReading, MANUAL_RAW } from "./account-usage-refresh.js";
import { deriveStaleUsage, parseUsageCache, USAGE_CACHE_MAX_AGE_MS, USAGE_CACHE_PATH } from "./usage-cache.js";

export interface ViewPaths {
  cache?: string;
  refresh?: string;
}

export type CacheHealth = "fresh" | "stale" | "missing" | "corrupt";

/** statusline 缓存此刻的状态（doctor 的「用量缓存有 / 没有 / 陈旧」也用它） */
export function usageCacheHealth(nowMs = Date.now(), path = USAGE_CACHE_PATH): CacheHealth {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt";
  }
  if (!parseUsageCache(raw, nowMs, Number.POSITIVE_INFINITY)) return "corrupt";
  return parseUsageCache(raw, nowMs, USAGE_CACHE_MAX_AGE_MS) ? "fresh" : "stale";
}

function fromCache(nowMs: number, path: string): { usage: AccountUsage | null; health: CacheHealth } {
  const health = usageCacheHealth(nowMs, path);
  if (health !== "fresh" && health !== "stale") return { usage: null, health };
  let c;
  try {
    c = parseUsageCache(readFileSync(path, "utf8"), nowMs, Number.POSITIVE_INFINITY);
  } catch {
    return { usage: null, health: "corrupt" }; // 两次读之间被删 / 换坏：按损坏报，本轮显示未知
  }
  if (!c) return { usage: null, health: "corrupt" };
  const d = health === "stale" ? deriveStaleUsage(c, nowMs) : c;
  return {
    health,
    usage: {
      sessionPct: d.sessionPct, sessionResets: d.sessionResets, weekPct: d.weekPct, weekResets: d.weekResets,
      // raw 是网页认来源的老约定（web/features/chat/usage-view.ts claudeQuotaSource），字面量别改
      totalCost: null, apiDuration: null, raw: health === "stale" ? "statusline cache (stale)" : "statusline cache", scrapedAt: d.scrapedAt,
      source: "statusline", stale: health === "stale", reason: health === "stale" ? "expired" : null,
    },
  };
}

/** 后台读数：最新的真实读数（带 source / stale / 观测时刻），都没有 = 未知 */
export function readAccountUsageView(nowMs = Date.now(), paths: ViewPaths = {}): AccountUsage {
  const { usage: cached, health } = fromCache(nowMs, paths.cache ?? USAGE_CACHE_PATH);
  const manual = lastManualReading(paths.refresh ?? ACCOUNT_USAGE_REFRESH_PATH);
  if (manual && (!cached || manual.scrapedAt > cached.scrapedAt)) {
    const fresh = nowMs - manual.scrapedAt <= USAGE_CACHE_MAX_AGE_MS;
    return { ...manual, raw: MANUAL_RAW, source: "manual", stale: !fresh, reason: fresh ? null : "expired" };
  }
  if (cached) {
    // cost / duration 只有 /status 面板有：沿用手动读数里的旧值
    return { ...cached, totalCost: manual?.totalCost ?? null, apiDuration: manual?.apiDuration ?? null };
  }
  return unknownUsage(health === "corrupt" ? "corrupt" : "missing");
}

function unknownUsage(reason: string): AccountUsage {
  return {
    sessionPct: null, sessionResets: "", weekPct: null, weekResets: "", totalCost: null, apiDuration: null,
    raw: "", scrapedAt: 0, source: "none", stale: true, reason,
  };
}
