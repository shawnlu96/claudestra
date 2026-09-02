/**
 * agent-stats readFileStats 单测 —— 重点：compact 后的上下文估算
 * （owner 2026-07-10 报告：compact 完很久不聊天，看板一直显示压缩前的大数）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileStats, POST_COMPACT_BASE_TOKENS } from "../src/lib/agent-stats.js";

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
