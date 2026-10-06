/**
 * lib/lend-quota-line-facts.ts（QLINE1）：读数并入、读失败沿用本代窗口读数（不当 0%）、resetAt 一过作废（重置世代）、
 * 新窗口替换旧窗口、时钟回拨（readAt 在未来）不信、落盘跨进程可读、坏文件当没有、缓存期限内不重读（测试进程不后台读）。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsNow, liveFact, mergeReport, readFactsFile, refreshQuotaFacts, resetQuotaFactsForTest, type FactsIo } from "../src/lib/lend-quota-line-facts.js";
import type { QuotaReport } from "../src/lib/quota-week.js";

const NOW = Date.parse("2026-10-06T06:00:00Z");
const RESET = NOW + 2 * 86_400_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => resetQuotaFactsForTest());
const io = (reads: (QuotaReport | Error)[]): FactsIo & { n: () => number } => {
  const d = mkdtempSync(join(tmpdir(), "qline-facts-"));
  dirs.push(d);
  let i = 0;
  return { path: join(d, "facts.json"), n: () => i, read: async () => { const r = reads[Math.min(i++, reads.length - 1)]; if (r instanceof Error) throw r; return r; } };
};

describe("并入规则（纯函数）", () => {
  test("读到的族换新、没读到的族沿用本代旧数", () => {
    const prev = { codex: { weekUsedPct: 82, resetAt: RESET, readAt: NOW - 60_000 } };
    expect(mergeReport(prev, { claude: { weekUsedPct: 5, resetAt: RESET } }, NOW)).toEqual({
      codex: prev.codex, claude: { weekUsedPct: 5, resetAt: RESET, readAt: NOW },
    });
  });
  test("旧数 resetAt 已过：丢掉，不当 0%、也不当旧百分比", () => {
    expect(mergeReport({ codex: { weekUsedPct: 95, resetAt: NOW, readAt: NOW - 1 } }, {}, NOW)).toEqual({});
  });
  test("新窗口读数替换旧窗口（重置世代）", () => {
    const next = NOW + 7 * 86_400_000;
    expect(mergeReport({ codex: { weekUsedPct: 95, resetAt: RESET, readAt: NOW - 1 } }, { codex: { weekUsedPct: 3, resetAt: next } }, NOW).codex)
      .toEqual({ weekUsedPct: 3, resetAt: next, readAt: NOW });
  });
  test("readAt 在本机时钟 5 分钟之后（时钟回拨 / 文件被改）：不信", () => {
    expect(liveFact({ weekUsedPct: 90, resetAt: RESET, readAt: NOW + 6 * 60_000 }, NOW)).toBeUndefined();
    expect(liveFact({ weekUsedPct: 90, resetAt: RESET, readAt: NOW + 60_000 }, NOW)).toBeDefined();
  });
});

describe("刷新 / 缓存 / 落盘", () => {
  test("读失败（抛错或 readWeekQuota 的空对象）：沿用上次本代读数，不当 0%", async () => {
    const x = io([{ codex: { weekUsedPct: 85, resetAt: RESET } }, new Error("boom"), {}]);
    expect((await refreshQuotaFacts(NOW, x)).codex?.weekUsedPct).toBe(85);
    expect((await refreshQuotaFacts(NOW + 60_000, x)).codex?.weekUsedPct).toBe(85);
    expect((await refreshQuotaFacts(NOW + 120_000, x)).codex).toEqual({ weekUsedPct: 85, resetAt: RESET, readAt: NOW });
  });
  test("读失败且已过 resetAt：unknown（空）", async () => {
    const x = io([{ codex: { weekUsedPct: 85, resetAt: RESET } }, new Error("boom")]);
    await refreshQuotaFacts(NOW, x);
    expect(await refreshQuotaFacts(RESET + 1, x)).toEqual({});
    expect(factsNow(RESET + 1, x)).toEqual({});
  });
  test("落盘：新进程（清内存）也能读到；坏文件当没有", async () => {
    const x = io([{ claude: { weekUsedPct: 81, resetAt: RESET } }]);
    await refreshQuotaFacts(NOW, x);
    resetQuotaFactsForTest();
    expect(factsNow(NOW + 1, x).claude?.weekUsedPct).toBe(81);
    expect(readFactsFile(x.path).claude?.resetAt).toBe(RESET);
    writeFileSync(x.path, "{bad");
    resetQuotaFactsForTest();
    expect(factsNow(NOW + 1, x)).toEqual({});
  });
  test("文件里混进非法值（百分比越界 / 非数）：那族丢掉", () => {
    const x = io([{}]);
    writeFileSync(x.path, JSON.stringify({ codex: { weekUsedPct: 101, resetAt: RESET, readAt: NOW }, claude: { weekUsedPct: "9", resetAt: RESET, readAt: NOW } }));
    expect(readFactsFile(x.path)).toEqual({});
  });
  test("测试进程里 factsNow 不后台读（不碰真额度）", () => {
    const x = io([{ codex: { weekUsedPct: 1, resetAt: RESET } }]);
    factsNow(NOW, x);
    expect(x.n()).toBe(0);
  });
  test("同一时刻只跑一份", async () => {
    const x = io([{ codex: { weekUsedPct: 1, resetAt: RESET } }]);
    await Promise.all([refreshQuotaFacts(NOW, x), refreshQuotaFacts(NOW, x)]);
    expect(x.n()).toBe(1);
  });
});
