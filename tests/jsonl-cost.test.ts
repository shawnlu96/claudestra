/**
 * JSONL cost rollup 单测
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rollupJsonl, mergeByModel, emptyUsage, projectsSlug } from "../src/lib/jsonl-cost.js";

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

describe("projectsSlug", () => {
  test("普通路径：去掉开头 / 后非字母数字统一换成 -", () => {
    // 用真实存在的目录（realpath 不改变非符号链接路径的语义）
    const dir = mkdtempSync(join(tmpdir(), "slug-plain-"));
    const real = realpathSync(dir);
    expect(projectsSlug(real)).toBe("-" + real.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("符号链接先 resolve 再算 slug（macOS /tmp → /private/tmp 一类）", () => {
    const base = mkdtempSync(join(tmpdir(), "slug-link-"));
    const realBase = realpathSync(base);
    const target = join(realBase, "real-target");
    const link = join(realBase, "the-link");
    mkdirSync(target);
    symlinkSync(target, link);
    expect(projectsSlug(link)).toBe(projectsSlug(target));
    expect(projectsSlug(link)).toContain("real-target");
    rmSync(base, { recursive: true, force: true });
  });

  test("v2.16.1 非字母数字统一转 -（对齐 CC 真实规则:下划线/点都转）", () => {
    // 2026-08-02 peer 实锤:cwd futures_data → CC 实际目录 futures-data;
    // 旧规则保留 _ 导致 live 历史失明/归档失位/cost 漏计
    expect(projectsSlug("/no/such/futures_data")).toBe("-no-such-futures-data");
    expect(projectsSlug("/no/such/.claude-orchestrator/master")).toBe("-no-such--claude-orchestrator-master");
    expect(projectsSlug("/no/such/a.b_c d")).toBe("-no-such-a-b-c-d");
  });

  test("路径不存在 → 按原样算 slug，不抛错", () => {
    expect(projectsSlug("/no/such/dir/xyz")).toBe("-no-such-dir-xyz");
  });
});
