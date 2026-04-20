/**
 * JSONL cost rollup 单测
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rollupJsonl, mergeByModel, emptyUsage } from "../src/lib/jsonl-cost.js";

function mkJsonl(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return path;
}

describe("rollupJsonl", () => {
  test("按 model 汇总 usage", async () => {
    const path = mkJsonl([
      {
        type: "assistant",
        timestamp: "2026-04-20T00:00:00.000Z",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-20T01:00:00.000Z",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-04-20T02:00:00.000Z",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
    ]);
    try {
      const res = await rollupJsonl(path);
      const opus = res.find((r) => r.model === "claude-opus-4-7");
      expect(opus).toBeDefined();
      expect(opus!.input).toBe(300);
      expect(opus!.output).toBe(130);
      expect(opus!.cacheRead).toBe(15);
      expect(opus!.cacheCreation).toBe(20);
      expect(opus!.requests).toBe(2);

      const sonnet = res.find((r) => r.model === "claude-sonnet-4-6");
      expect(sonnet).toBeDefined();
      expect(sonnet!.input).toBe(50);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("sinceTs 过滤旧记录", async () => {
    const path = mkJsonl([
      {
        type: "assistant",
        timestamp: "2026-04-01T00:00:00.000Z",
        message: { model: "opus", usage: { input_tokens: 999, output_tokens: 0 } },
      },
      {
        type: "assistant",
        timestamp: "2026-04-20T00:00:00.000Z",
        message: { model: "opus", usage: { input_tokens: 10, output_tokens: 0 } },
      },
    ]);
    try {
      const since = new Date("2026-04-15T00:00:00Z").getTime();
      const res = await rollupJsonl(path, since);
      const opus = res.find((r) => r.model === "opus")!;
      expect(opus.input).toBe(10); // 只有新的被计入
      expect(opus.requests).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("user 消息忽略（只统计 assistant）", async () => {
    const path = mkJsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        timestamp: "2026-04-20T00:00:00.000Z",
        message: { model: "opus", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);
    try {
      const res = await rollupJsonl(path);
      expect(res.length).toBe(1);
      expect(res[0].requests).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("不存在的 path 返回空数组", async () => {
    const res = await rollupJsonl("/nonexistent/path.jsonl");
    expect(res).toEqual([]);
  });
});

describe("mergeByModel", () => {
  test("把多条 model 用量合并成一条", () => {
    const rows = [
      { model: "opus", input: 10, output: 5, cacheRead: 0, cacheCreation: 0, requests: 1 },
      { model: "opus", input: 20, output: 10, cacheRead: 0, cacheCreation: 0, requests: 2 },
      { model: "sonnet", input: 5, output: 2, cacheRead: 0, cacheCreation: 0, requests: 1 },
    ];
    const res = mergeByModel(rows);
    expect(res.length).toBe(2);
    const opus = res.find((r) => r.model === "opus")!;
    expect(opus.input).toBe(30);
    expect(opus.output).toBe(15);
    expect(opus.requests).toBe(3);
  });
});

describe("emptyUsage", () => {
  test("返回全 0 对象", () => {
    const u = emptyUsage();
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.requests).toBe(0);
  });
});
