/**
 * lib/lend-quota-line-facts.ts（QLINE1）：读数并入（按真实观测时刻 observedAt 选、保留来源）、旧快照重读不变新也盖不掉更新的事实、
 * 真正更新的低读数能恢复、读失败沿用本代窗口读数（不当 0%）、resetAt 一过作废（重置世代）、新窗口替换旧窗口、
 * 时钟回拨（observedAt 在未来）不信、没有来源 / 观测时刻的不算读到、落盘跨进程可读、坏文件当没有、测试进程不后台读。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { factOf, factsNow, liveFact, mergeReport, readFactsFile, refreshQuotaFacts, resetQuotaFactsForTest, type FactsIo, type QuotaInventory } from "../src/lib/lend-quota-line-facts.js";

const NOW = Date.parse("2026-10-06T06:00:00Z");
const RESET = NOW + 2 * 86_400_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => resetQuotaFactsForTest());

/** 合成的 AI 清单额度段（与 ai-quota.ts 同形状）：只含周窗口 */
const inv = (usedPct: number | null, o: { resetAt?: number; observedAt?: number | null; source?: InventoryQuota["source"] } = {}): InventoryQuota => ({
  status: usedPct === null ? "unknown" : "known", source: o.source === undefined ? "live" : o.source, observedAt: o.observedAt === undefined ? NOW : o.observedAt,
  plan: null, reason: null, windows: [{ id: "7d", kind: "weekly", usedPct, resetsAtMs: o.resetAt ?? RESET, resetPassed: false }],
});
const io = (reads: (QuotaInventory | Error)[]): FactsIo & { n: () => number } => {
  const d = mkdtempSync(join(tmpdir(), "qline-facts-"));
  dirs.push(d);
  let i = 0;
  return { path: join(d, "facts.json"), n: () => i, read: async () => { const r = reads[Math.min(i++, reads.length - 1)]; if (r instanceof Error) throw r; return r; } };
};

describe("清单 → 事实", () => {
  test("保留来源与真实观测时刻，周窗口经 quota-week weekOf（整数、夹 0..100）", () => {
    expect(factOf(inv(42.4, { observedAt: NOW - 5_000, source: "local_cache" }), NOW)).toEqual({ weekUsedPct: 42, resetAt: RESET, observedAt: NOW - 5_000, source: "local_cache" });
  });
  test("没有观测时刻 / 来源不可识别 / unknown / 窗口已过重置：不算读到", () => {
    expect(factOf(inv(50, { observedAt: null }), NOW)).toBeUndefined();
    expect(factOf(inv(50, { source: null }), NOW)).toBeUndefined();
    expect(factOf(inv(50, { source: "none" }), NOW)).toBeUndefined();
    expect(factOf(inv(null), NOW)).toBeUndefined();
    expect(factOf(inv(50, { resetAt: NOW }), NOW)).toBeUndefined();
  });
});

describe("并入规则（纯函数）", () => {
  const f = (pct: number, observedAt: number, source: "live" | "live_stale" | "local_cache" = "live", resetAt = RESET) => ({ weekUsedPct: pct, resetAt, observedAt, source });
  test("读到的族换新、没读到的族沿用本代旧数", () => {
    const prev = { codex: f(82, NOW - 60_000) };
    expect(mergeReport(prev, { claude: inv(5) }, NOW)).toEqual({ codex: prev.codex, claude: f(5, NOW) });
  });
  test("旧快照（观测更早的 live_stale 10%）盖不掉更新的 85%：观测时刻不被改写成本次读取时刻", () => {
    const prev = { codex: f(85, NOW - 60_000) };
    const out = mergeReport(prev, { codex: inv(10, { observedAt: NOW - 2 * 86_400_000 + 1, source: "live_stale" }) }, NOW);
    expect(out.codex).toEqual(prev.codex);
  });
  test("真正更新的低读数（重置卡 / 账号修正）能恢复：观测更新的那份胜出，不取 max", () => {
    expect(mergeReport({ codex: f(85, NOW - 60_000) }, { codex: inv(10, { observedAt: NOW - 1_000 }) }, NOW).codex).toEqual(f(10, NOW - 1_000));
  });
  test("同一观测时刻：以本次读数为准", () => {
    expect(mergeReport({ codex: f(85, NOW) }, { codex: inv(30, { observedAt: NOW }) }, NOW).codex?.weekUsedPct).toBe(30);
  });
  test("旧数 resetAt 已过：丢掉，不当 0%、也不当旧百分比", () => {
    expect(mergeReport({ codex: f(95, NOW - 1, "live", NOW) }, {}, NOW)).toEqual({});
  });
  test("新窗口读数替换旧窗口（重置世代）", () => {
    const next = NOW + 7 * 86_400_000;
    expect(mergeReport({ codex: f(95, NOW - 1) }, { codex: inv(3, { resetAt: next }) }, NOW).codex).toEqual(f(3, NOW, "live", next));
  });
  test("observedAt 在本机时钟 5 分钟之后（时钟回拨 / 文件被改）：不信", () => {
    expect(liveFact(f(90, NOW + 6 * 60_000), NOW)).toBeUndefined();
    expect(liveFact(f(90, NOW + 60_000), NOW)).toBeDefined();
    expect(mergeReport({}, { codex: inv(90, { observedAt: NOW + 6 * 60_000 }) }, NOW)).toEqual({});
  });
});

describe("刷新 / 缓存 / 落盘", () => {
  test("读失败（抛错或空清单）：沿用上次本代读数（观测时刻不变），不当 0%", async () => {
    const x = io([{ codex: inv(85) }, new Error("boom"), {}]);
    expect((await refreshQuotaFacts(NOW, x)).codex?.weekUsedPct).toBe(85);
    expect((await refreshQuotaFacts(NOW + 60_000, x)).codex?.weekUsedPct).toBe(85);
    expect((await refreshQuotaFacts(NOW + 120_000, x)).codex).toEqual({ weekUsedPct: 85, resetAt: RESET, observedAt: NOW, source: "live" });
  });
  test("读失败且已过 resetAt：unknown（空）", async () => {
    const x = io([{ codex: inv(85) }, new Error("boom")]);
    await refreshQuotaFacts(NOW, x);
    expect(await refreshQuotaFacts(RESET + 1, x)).toEqual({});
    expect(factsNow(RESET + 1, x)).toEqual({});
  });
  test("跨进程：落盘的 85%（一分钟前）不被另一进程读到的两天前旧快照 10% 覆盖", async () => {
    const x = io([{ codex: inv(85, { observedAt: NOW - 60_000 }) }, { codex: inv(10, { observedAt: NOW - 2 * 86_400_000, source: "live_stale" }) }]);
    await refreshQuotaFacts(NOW, x);
    resetQuotaFactsForTest();
    expect((await refreshQuotaFacts(NOW + 60_000, x)).codex).toMatchObject({ weekUsedPct: 85, observedAt: NOW - 60_000, source: "live" });
    expect(readFactsFile(x.path).codex?.weekUsedPct).toBe(85);
  });
  test("落盘：新进程（清内存）也能读到；坏文件当没有", async () => {
    const x = io([{ claude: inv(81) }]);
    await refreshQuotaFacts(NOW, x);
    resetQuotaFactsForTest();
    expect(factsNow(NOW + 1, x).claude?.weekUsedPct).toBe(81);
    expect(readFactsFile(x.path).claude?.resetAt).toBe(RESET);
    writeFileSync(x.path, "{bad");
    resetQuotaFactsForTest();
    expect(factsNow(NOW + 1, x)).toEqual({});
  });
  test("文件里混进非法值（百分比越界 / 非数 / 来源不认识 / 旧格式）：那族丢掉", () => {
    const x = io([{}]);
    writeFileSync(x.path, JSON.stringify({ codex: { weekUsedPct: 101, resetAt: RESET, observedAt: NOW, source: "live" }, claude: { weekUsedPct: 9, resetAt: RESET, readAt: NOW } }));
    expect(readFactsFile(x.path)).toEqual({});
    writeFileSync(x.path, JSON.stringify({ codex: { weekUsedPct: 9, resetAt: RESET, observedAt: NOW, source: "guess" } }));
    expect(readFactsFile(x.path)).toEqual({});
  });
  test("测试进程里 factsNow 不后台读（不碰真额度）", () => {
    const x = io([{ codex: inv(1) }]);
    factsNow(NOW, x);
    expect(x.n()).toBe(0);
  });
  test("同一时刻只跑一份", async () => {
    const x = io([{ codex: inv(1) }]);
    await Promise.all([refreshQuotaFacts(NOW, x), refreshQuotaFacts(NOW, x)]);
    expect(x.n()).toBe(1);
  });
});
