/**
 * 全机用量（src/lib/machine-usage.ts）与 bridge 侧缓存（src/lib/machine-usage-cache.ts）。
 * 重点：按响应去重（同文件多行同一 usage、fork 抄进新文件的历史行）、窗口过滤（mtime + 时间戳）、跨块拼行。
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanMachineUsage, listRecentJsonl } from "../src/lib/machine-usage.js";
import { createMachineUsageCache } from "../src/lib/machine-usage-cache.js";
import type { UsageWindowBounds } from "../src/lib/usage-window.js";

const H = 3600_000;
const NOW = Date.now();
const W: UsageWindowBounds = { dayStart: NOW - 5 * H, weekStart: NOW - 3 * 24 * H, weekSource: "quota" };

/** 一次 API 响应被写成 blocks 行（thinking / text / tool_use 各一行），每行带同一份 usage */
function response(id: string, ts: number, tokens: number, blocks = 3): object[] {
  const usage = { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return Array.from({ length: blocks }, (_, i) => ({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model: "claude-opus-5-5", usage, content: [{ type: "text", text: `块${i}` }] },
  }));
}

function writeJsonl(dir: string, name: string, recs: object[], mtime = NOW): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  // 夹一行长正文，让小块读取必然切在行中间
  const filler = { type: "user", timestamp: new Date(NOW - H).toISOString(), message: { content: "长".repeat(3000) } };
  writeFileSync(p, [filler, ...recs].map((o) => JSON.stringify(o)).join("\n") + "\n");
  utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "machine-usage-"));
  const proj = join(root, "-Users-x-repo");
  writeJsonl(proj, "a.jsonl", [...response("1", NOW - 2 * H, 100), ...response("2", NOW - 30 * H, 1000)]);
  // fork 出来的新会话：抄了 a 的历史（msg_1），又有自己的新响应
  writeJsonl(proj, "b.jsonl", [...response("1", NOW - 2 * H, 100), ...response("3", NOW - H, 10)]);
  // 子 agent / workflow 子 agent：深层目录
  writeJsonl(join(proj, "a", "subagents", "workflows", "wf_1"), "agent-x.jsonl", response("4", NOW - H, 7, 1));
  // 窗口外：mtime 早于周期起点，整个文件不读（里面即使有「窗口内」的时间戳也不算——那不可能是真的）
  writeJsonl(proj, "old.jsonl", response("5", NOW - H, 99999), NOW - 4 * 24 * H);
  // 窗口内文件里的旧记录：早于周期起点的不计
  writeJsonl(proj, "c.jsonl", [...response("6", NOW - 5 * 24 * H, 5000), ...response("7", NOW - 10 * H, 3)]);
  return root;
}

describe("scanMachineUsage", () => {
  test("去重 + 窗口过滤 + 深层子 agent", async () => {
    const root = fixture();
    const m = await scanMachineUsage(W, [root]);
    expect(m.files).toBe(4); // old.jsonl 按 mtime 跳过
    // 今日：msg_1(100) + msg_3(10) + msg_4(7)；本周再加 msg_2(1000，30h 前) + msg_7(3，10h 前)
    expect(m.today.tokens).toBe(117);
    expect(m.week.tokens).toBe(1120);
    expect(m.week.requests).toBe(5);
    expect(m.byRuntime["claude-code"].week.tokens).toBe(1120);
  });

  test("小块读取（跨块拼行，含多字节中文）与整块读取结果一致", async () => {
    const root = fixture();
    const big = await scanMachineUsage(W, [root]);
    for (const chunk of [64, 333, 4096]) {
      const small = await scanMachineUsage(W, [root], chunk);
      expect(small.today).toEqual(big.today);
      expect(small.week).toEqual(big.week);
    }
  });

  test("根目录不存在（没装这个运行时）不炸", async () => {
    expect(listRecentJsonl([join(tmpdir(), "no-such-root-machine-usage")], 0)).toEqual([]);
  });
});

describe("createMachineUsageCache", () => {
  const data = (tokens: number) => ({ today: { tokens }, week: { tokens }, byRuntime: {}, window: W, scannedAt: 0 });

  test("首次等结果；TTL 内复用；过期先回旧值、后台刷新；同时只跑一个", async () => {
    let t = 0;
    let calls = 0;
    let n = 0;
    const run = async (args: string[]) => {
      calls++;
      expect(args).toEqual(["cost", "--machine", "--window", `${W.dayStart},${W.weekStart},quota`]);
      return { ok: true, machine: data(++n) };
    };
    const get = createMachineUsageCache(run, { ttlMs: 60_000, now: () => t, log: () => {} });
    expect((await get(W))!.week.tokens).toBe(1);
    t = 30_000;
    expect((await get(W))!.week.tokens).toBe(1);
    expect(calls).toBe(1);
    t = 61_000;
    const [a, b] = await Promise.all([get(W), get(W)]);
    expect(a!.week.tokens).toBe(1); // 旧值先回
    expect(b!.week.tokens).toBe(1);
    await Bun.sleep(0);
    expect(calls).toBe(2); // 两次 get 只起了一个刷新
    expect((await get(W))!.week.tokens).toBe(2);
  });

  test("失败沿用旧值；窗口变了不返回旧口径的数", async () => {
    let fail = false;
    let t = 0;
    const logs: string[] = [];
    const get = createMachineUsageCache(async () => (fail ? { ok: false, error: "boom" } : { ok: true, machine: data(5) }), {
      ttlMs: 10, now: () => t, log: (m) => logs.push(m), waitMs: 50,
    });
    expect((await get(W))!.week.tokens).toBe(5);
    fail = true;
    t = 100;
    expect((await get(W))!.week.tokens).toBe(5);
    await Bun.sleep(0);
    expect(logs.length).toBe(1);
    const next = { ...W, dayStart: W.dayStart + 24 * H };
    expect(await get(next)).toBeNull();
  });

  test("失败后 TTL 内不再起子进程（Stop hook 每几秒来问一次）", async () => {
    let t = 0;
    let calls = 0;
    const get = createMachineUsageCache(async () => (calls++, { ok: false, error: "boom" }), { ttlMs: 60_000, now: () => t, log: () => {} });
    expect(await get(W)).toBeNull();
    t = 5_000;
    expect(await get(W)).toBeNull();
    t = 30_000;
    expect(await get(W)).toBeNull();
    expect(calls).toBe(1);
    t = 61_000;
    await get(W);
    expect(calls).toBe(2);
  });

  test("子进程卡住：最多等 waitMs 就返回 null，不拖住看板", async () => {
    const get = createMachineUsageCache(() => new Promise(() => {}), { waitMs: 20, log: () => {} });
    const t0 = Date.now();
    expect(await get(W)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("Pi 按接入商拆（piProviders）", () => {
  const piLine = (id: string, ts: number, provider: unknown, input: number, cost: number) => ({
    type: "message", id, parentId: null, timestamp: new Date(ts).toISOString(),
    message: { role: "assistant", provider, model: "m-1", usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, content: [] },
  });

  test("按会话行的 provider 分桶；名字不合规归 unknown；总账与分桶一致", async () => {
    const root = mkdtempSync(join(tmpdir(), "machine-usage-pi-"));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
    try {
      const dir = join(root, "pi", "sessions", "--Users-x-repo--");
      writeJsonl(dir, "2026-09-28T00-00-00-000Z_s1.jsonl", [
        piLine("p1", NOW - H, "acme-go", 100, 0.5),
        piLine("p2", NOW - 30 * H, "acme-go", 1000, 1),
        piLine("p3", NOW - H, "other.cloud", 7, 0.01),
        piLine("p4", NOW - H, "bad name/../x", 3, 0),
        piLine("p5", NOW - H, undefined, 2, 0),
      ]);
      // fork 抄了 p1：不重复计
      writeJsonl(dir, "2026-09-28T01-00-00-000Z_s2.jsonl", [piLine("p1", NOW - H, "acme-go", 100, 0.5)]);
      const m = await scanMachineUsage(W, [join(root, "pi", "sessions")]);
      expect(Object.keys(m.piProviders).sort()).toEqual(["acme-go", "other.cloud", "unknown"]);
      expect(m.piProviders["acme-go"].week.tokens).toBe(1100);
      expect(m.piProviders["acme-go"].today.tokens).toBe(100);
      expect(m.piProviders["acme-go"].week.reportedCostUsd).toBeCloseTo(1.5);
      expect(m.piProviders.unknown.week.tokens).toBe(5);
      const sum = Object.values(m.piProviders).reduce((a, p) => a + p.week.tokens, 0);
      expect(sum).toBe(m.byRuntime.pi.week.tokens);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  test("Claude Code 会话不进 piProviders", async () => {
    const m = await scanMachineUsage(W, [fixture()]);
    expect(m.piProviders).toEqual({});
  });
});
