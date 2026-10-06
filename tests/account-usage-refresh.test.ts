/**
 * 手动刷新闸（lib/account-usage-refresh.ts）：失败后 30 分钟内再点不探测（含边界）、并发只探测一次、
 * 重启（新的闸实例 / 中途崩溃留下的 inFlight）不能绕过退避且只回收记录里的探测资源、成功更新真实时间、
 * 落盘不含 pane 原文。假探测，零 tmux、零模型。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANUAL_REFRESH_BACKOFF_MS, manualRefresh, type ProbeResource, type ProbeResult } from "../src/lib/account-usage-refresh.ts";
import type { AccountUsage } from "../src/lib/account-usage-panel.ts";

const dir = mkdtempSync(join(tmpdir(), "acct-refresh-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshPath = () => join(dir, `state-${n++}.json`);
const T0 = 1_787_798_183_000;

const usage = (at: number): AccountUsage => ({ sessionPct: 12, weekPct: 34, sessionResets: "7pm", weekResets: "Jul 16", totalCost: null,
  apiDuration: null, raw: "Settings Status Config Usage\nCurrent session 12% used SECRET-PANE-TEXT", scrapedAt: at });

function fakeProbe(results: ProbeResult[], opts: { resource?: ProbeResource; delayMs?: number } = {}) {
  const calls = { run: 0, cleanup: [] as ProbeResource[] };
  return {
    calls,
    probe: {
      run: async (onCreated: (r: ProbeResource) => void) => {
        calls.run++;
        if (opts.resource) onCreated(opts.resource);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return results.shift() ?? { ok: false, reason: "no more" };
      },
      cleanup: async (r: ProbeResource) => void calls.cleanup.push(r),
    },
  };
}

describe("manualRefresh", () => {
  test("失败 → 30 分钟内再点不探测，返回旧读数/未知 + 下一可刷新时间；边界那一刻放行", async () => {
    const path = freshPath();
    let now = T0;
    const f = fakeProbe([{ ok: false, reason: "probe_start_timeout" }, { ok: true, usage: usage(T0 + MANUAL_REFRESH_BACKOFF_MS) }]);
    const first = await manualRefresh({ path, now: () => now, probe: f.probe });
    expect(first).toMatchObject({ outcome: "failed", usage: null, nextAllowedAt: T0 + MANUAL_REFRESH_BACKOFF_MS });
    now = T0 + MANUAL_REFRESH_BACKOFF_MS - 1;
    const second = await manualRefresh({ path, now: () => now, probe: f.probe });
    expect(second).toMatchObject({ outcome: "backoff", usage: null, nextAllowedAt: T0 + MANUAL_REFRESH_BACKOFF_MS });
    expect(f.calls.run).toBe(1);
    now = T0 + MANUAL_REFRESH_BACKOFF_MS;
    const third = await manualRefresh({ path, now: () => now, probe: f.probe });
    expect(third.outcome).toBe("refreshed");
    expect(third.usage?.scrapedAt).toBe(T0 + MANUAL_REFRESH_BACKOFF_MS);
    expect(f.calls.run).toBe(2);
  });

  test("成功：读数带真实时间；落盘不含面板原文、也不随结果发出", async () => {
    const path = freshPath();
    const f = fakeProbe([{ ok: true, usage: usage(T0 + 5) }]);
    const r = await manualRefresh({ path, now: () => T0, probe: f.probe });
    expect(r.usage).toMatchObject({ sessionPct: 12, weekPct: 34, scrapedAt: T0 + 5, source: "manual", stale: false });
    expect(r.usage!.raw).not.toContain("SECRET");
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain("SECRET");
    expect(JSON.parse(disk).lastReading.scrapedAt).toBe(T0 + 5);
  });

  test("失败后旧读数保留（不抹成未知、不当 0）", async () => {
    const path = freshPath();
    let now = T0;
    const f = fakeProbe([{ ok: true, usage: usage(T0) }, { ok: false, reason: "probe_no_usage_tab" }]);
    await manualRefresh({ path, now: () => now, probe: f.probe });
    now += 1000;
    const r = await manualRefresh({ path, now: () => now, probe: f.probe });
    expect(r).toMatchObject({ outcome: "failed", reason: "probe_no_usage_tab" });
    expect(r.usage).toMatchObject({ sessionPct: 12, scrapedAt: T0, stale: true });
  });

  test("并发：同进程三次点击只探测一次，拿同一结果", async () => {
    const path = freshPath();
    const f = fakeProbe([{ ok: true, usage: usage(T0) }], { delayMs: 30 });
    const rs = await Promise.all([1, 2, 3].map(() => manualRefresh({ path, now: () => T0, probe: f.probe })));
    expect(f.calls.run).toBe(1);
    expect(rs.every((r) => r.outcome === "refreshed")).toBe(true);
  });

  test("跨进程：锁被别人持有 → busy，不探测", async () => {
    const path = freshPath();
    const { acquireLock } = await import("../src/lib/file-lock.ts");
    const held = await acquireLock(`${path}.lock`, 0);
    const f = fakeProbe([{ ok: true, usage: usage(T0) }]);
    const r = await manualRefresh({ path, now: () => T0, probe: f.probe });
    held!.release();
    expect(r.outcome).toBe("busy");
    expect(f.calls.run).toBe(0);
  });

  test("重启：落盘的失败退避对新进程照样生效（直接读状态文件）", async () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ lastAttemptAt: T0, lastFailureAt: T0, lastFailureReason: "probe_start_timeout",
      nextAllowedAt: T0 + MANUAL_REFRESH_BACKOFF_MS, inFlight: null, lastReading: null }));
    const f = fakeProbe([{ ok: true, usage: usage(T0) }]);
    const r = await manualRefresh({ path, now: () => T0 + 60_000, probe: f.probe });
    expect(r.outcome).toBe("backoff");
    expect(f.calls.run).toBe(0);
  });

  test("重启：上一进程探测到一半崩了 → 记为失败退避，只回收它记录的那份探测资源", async () => {
    const path = freshPath();
    const leftover: ProbeResource = { session: "cstra-usage-probe-deadbeef", id: "$7", dir: "/tmp/x" };
    writeFileSync(path, JSON.stringify({ lastAttemptAt: T0, lastFailureAt: null, lastFailureReason: null, nextAllowedAt: null,
      inFlight: { startedAt: T0, pid: 1, probe: leftover }, lastReading: null }));
    const f = fakeProbe([{ ok: true, usage: usage(T0) }]);
    const r = await manualRefresh({ path, now: () => T0 + 1000, probe: f.probe });
    expect(r).toMatchObject({ outcome: "backoff", reason: "interrupted", nextAllowedAt: T0 + MANUAL_REFRESH_BACKOFF_MS });
    expect(f.calls.cleanup).toEqual([leftover]);
    expect(f.calls.run).toBe(0);
  });

  test("探测抛异常 = 失败并退避；状态文件损坏 = 不探测不覆盖", async () => {
    const path = freshPath();
    const boom = { run: async () => { throw new Error("tmux gone"); }, cleanup: async () => {} };
    const r = await manualRefresh({ path, now: () => T0, probe: boom });
    expect(r.outcome).toBe("failed");
    expect(r.reason).toContain("tmux gone");
    const bad = freshPath();
    writeFileSync(bad, "{bad");
    const f = fakeProbe([{ ok: true, usage: usage(T0) }]);
    expect((await manualRefresh({ path: bad, now: () => T0, probe: f.probe })).outcome).toBe("failed");
    expect(f.calls.run).toBe(0);
    expect(readFileSync(bad, "utf8")).toBe("{bad");
  });
});
