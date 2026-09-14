/**
 * agent-stats readFileStats 单测 —— 重点：compact 后的上下文估算
 * （owner 2026-07-10 报告：compact 完很久不聊天，看板一直显示压缩前的大数）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileStats, scanStatsWindow, POST_COMPACT_BASE_TOKENS } from "../src/lib/agent-stats.js";

let seq = 0;
function mkJsonl(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-stats-test-"));
  const path = join(dir, `session-${seq++}.jsonl`);
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return path;
}

const now = new Date().toISOString();

function assistantUsage(input: number, cacheRead: number, model = "claude-fable-5") {
  return {
    type: "assistant",
    timestamp: now,
    message: {
      model,
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 100 },
    },
  };
}

describe("readFileStats compact 感知", () => {
  test("无 compact：上下文 = 尾部第一条 usage", async () => {
    const path = mkJsonl([assistantUsage(1000, 400_000), assistantUsage(2000, 500_000)]);
    const s = await readFileStats(path);
    expect(s.contextTokens).toBe(502_000);
    expect(s.contextEstimated).toBe(false);
    expect(s.model).toBe("claude-fable-5");
  });

  test("compact 后无新对话：估算 = 底座 + 摘要/4，标记 estimated，model 仍取压缩前", async () => {
    const summary = "x".repeat(8000);
    const path = mkJsonl([
      assistantUsage(2000, 500_000),
      { type: "system", subtype: "compact_boundary", timestamp: now },
      { type: "user", isCompactSummary: true, timestamp: now, message: { role: "user", content: summary } },
    ]);
    const s = await readFileStats(path);
    expect(s.contextEstimated).toBe(true);
    expect(s.contextTokens).toBe(POST_COMPACT_BASE_TOKENS + 2000);
    expect(s.contextTokens).toBeLessThan(100_000); // 不再是压缩前的 50 万
    expect(s.model).toBe("claude-fable-5");
  });

  test("compact 后已有新对话：回到 usage 实测，不再估算", async () => {
    const path = mkJsonl([
      assistantUsage(2000, 500_000),
      { type: "system", subtype: "compact_boundary", timestamp: now },
      { type: "user", isCompactSummary: true, timestamp: now, message: { role: "user", content: "summary" } },
      assistantUsage(3000, 55_000),
    ]);
    const s = await readFileStats(path);
    expect(s.contextEstimated).toBe(false);
    expect(s.contextTokens).toBe(58_000);
  });

  test("摘要是 content block 数组也能估算", async () => {
    const path = mkJsonl([
      assistantUsage(2000, 500_000),
      {
        type: "user",
        isCompactSummary: true,
        timestamp: now,
        message: { role: "user", content: [{ type: "text", text: "y".repeat(4000) }] },
      },
    ]);
    const s = await readFileStats(path);
    expect(s.contextEstimated).toBe(true);
    expect(s.contextTokens).toBe(POST_COMPACT_BASE_TOKENS + 1000);
  });
});

// [fork] costOfUsage：模型计价（2026-07 API 牌价折算,web 看板全机成本数据源）
import { costOfUsage } from "../src/lib/agent-stats.js";

describe("costOfUsage", () => {
  test("fable: in 10 / out 50 / cw 12.5 / cr 1 per Mtok", () => {
    const c = costOfUsage("claude-fable-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(c).toBeCloseTo(10 + 50 + 12.5 + 1, 6);
  });

  test("fable-5-1: cache read 0.25，其余同 fable-5；老 fable-5 不受影响", () => {
    expect(costOfUsage("claude-fable-5-1", { cache_read_input_tokens: 4_000_000 })).toBeCloseTo(1, 6);
    expect(costOfUsage("claude-fable-5-1", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(60, 6);
    expect(costOfUsage("claude-fable-5", { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(1, 6);
  });

  test("opus-4-8 命中专价而不是老 opus 价", () => {
    expect(costOfUsage("claude-opus-4-8", { input_tokens: 1_000_000 })).toBeCloseTo(5, 6);
  });

  test("老 opus 走 15/75", () => {
    expect(costOfUsage("claude-opus-4-1-20250805", { output_tokens: 1_000_000 })).toBeCloseTo(75, 6);
  });

  test("haiku cache read 0.1", () => {
    expect(costOfUsage("claude-haiku-4-5-20251001", { cache_read_input_tokens: 10_000_000 })).toBeCloseTo(1, 6);
  });

  test("未知模型不计价（宁少报不虚报）", () => {
    expect(costOfUsage("<synthetic>", { input_tokens: 5_000_000 })).toBe(0);
  });
});

// ── 尾读 + 扩窗（2026-09-15 bridge OOM 根因）────────────────────────────────
// 原先 readFileStats 无条件全文读：538MB 的会话一次吃 ~2.5GB JS 堆，而 Stop hook
// 每回合触发 → bridge RSS 棘轮涨到 3.4GB。改成尾读 + 「回溯过周界才停」的扩窗。
// 这里用 tailStartBytes 把窗口逼到几十字节，在小 fixture 上验扩窗逻辑。
describe("readFileStats 尾读扩窗", () => {
  const DAY = 86400_000;
  function atDaysAgo(d: number) {
    return new Date(Date.now() - d * DAY).toISOString();
  }
  function usageAt(ts: string, out: number) {
    return {
      type: "assistant",
      timestamp: ts,
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out },
      },
    };
  }

  // ⚠ readFileStats 的 5 秒桶缓存是**按 path 键**的：同一路径调两次，第二次必吃缓存，
  //   参数不同也没用。所以每个对照组都写成两份内容相同、路径不同的文件。
  test("窗口再小也要扩到回溯过周界，本周合计与全读一致", async () => {
    // 20 天前 → 今天，跨周界；每条 output 都不同，漏一条就对不上
    const recs = Array.from({ length: 40 }, (_, i) => usageAt(atDaysAgo(20 - i * 0.5), i + 1));
    const full = await readFileStats(mkJsonl(recs), { tailStartBytes: 1 << 30 });
    const tail = await readFileStats(mkJsonl(recs), { tailStartBytes: 64 }); // 逼扩窗
    expect(tail.week).toEqual(full.week);
    expect(tail.today).toEqual(full.today);
    expect(tail.contextTokens).toBe(full.contextTokens);
    expect(tail.model).toBe(full.model);
    expect(full.week.requests).toBeGreaterThan(0); // fixture 本身有效
    expect(full.week.requests).toBeLessThan(recs.length); // 确实有记录落在周界外
  });

  // ⚠ 真实 jsonl 是 append-only 的「旧 → 新」。fixture 必须同序，否则尾窗第一条就是
  //   最老的记录、一上来就越过周界，扩窗逻辑根本走不到（第一版测试就栽在这）。
  test("整个文件都在本周内 → 扩到文件头即停，不死循环", async () => {
    // 全部打「此刻」：now >= weekStart 恒成立，不受跑测时间影响
    const recs = Array.from({ length: 12 }, (_, i) => usageAt(new Date().toISOString(), i + 1));
    const tail = await readFileStats(mkJsonl(recs), { tailStartBytes: 32 });
    const full = await readFileStats(mkJsonl(recs), { tailStartBytes: 1 << 30 });
    expect(tail.week).toEqual(full.week);
    expect(tail.week.requests).toBe(recs.length); // 一条不漏（没有记录在周界外）
  });

  test("窗口从半行中间切入：截断的首行被丢弃，不产生错数", async () => {
    const recs = Array.from({ length: 30 }, (_, i) => usageAt(new Date().toISOString(), i + 1));
    const full = await readFileStats(mkJsonl(recs), { tailStartBytes: 1 << 30 });
    expect(full.week.requests).toBe(recs.length);
    // 刻意取不落在行边界上的窗口大小
    for (const w of [37, 91, 143]) {
      const tail = await readFileStats(mkJsonl(recs), { tailStartBytes: w });
      expect(tail.week).toEqual(full.week);
    }
  });

  test("scanStatsWindow：没有可解析时间戳时 oldestTs = Infinity（调用方据此继续扩窗）", () => {
    const r = scanStatsWindow(["", "{坏行", "not json"], Date.now(), Date.now() - 7 * DAY);
    expect(r.oldestTs).toBe(Infinity);
    expect(r.stats.week.requests).toBe(0);
  });
});
