/**
 * lib/quota-pi.ts：全机扫描的 piProviders → 看板的 `pi:<provider>` 条目（本周 tokens / 花费，数据层是本机记录）。
 */

import { describe, expect, test } from "bun:test";
import { piProviderEntries } from "../src/lib/quota-pi.js";

const H = 3600_000;
const T = Date.parse("2026-09-28T09:00:00Z");
const win = (tokens: number, costUsd = 0, reportedCostUsd = 0, requests = tokens ? 1 : 0) => ({ tokens, requests, costUsd, reportedCostUsd });
const pair = (week: ReturnType<typeof win>) => ({ today: win(0), week });

describe("piProviderEntries", () => {
  test("按本周 tokens 从多到少；本周无记录的不出；花费 = 自报 + 牌价估算", () => {
    const out = piProviderEntries({
      scannedAt: T,
      window: { dayStart: T - 9 * H, weekStart: T - 5 * 24 * H, weekSource: "quota" },
      piProviders: { small: pair(win(10, 0.1)), big: pair(win(900, 0, 2.5)), idle: pair(win(0)) },
    });
    expect(out.map((e) => e.id)).toEqual(["pi:big", "pi:small"]);
    expect(out[0]).toMatchObject({ name: "big", kind: "api", account: { key: null, identity: "unknown" }, source: { layer: "local_cache", observedAt: T, reason: null } });
    expect(out[0].meters).toEqual([
      { id: "week_tokens", kind: "usage", label: null, unit: "tokens", used: 900, periodMinutes: 5 * 24 * 60 },
      { id: "week_usd", kind: "usage", label: null, unit: "usd", used: 2.5, periodMinutes: 5 * 24 * 60 },
    ]);
    expect(out[1].meters[1].used).toBeCloseTo(0.1);
  });

  test("没有全机数据（首扫未出 / 沙箱 / 老子进程没这个字段）→ 空", () => {
    expect(piProviderEntries(null)).toEqual([]);
    expect(piProviderEntries({ scannedAt: T, window: { dayStart: T, weekStart: T, weekSource: "rolling" } } as never)).toEqual([]);
  });
});
