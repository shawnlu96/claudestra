import { describe, expect, test } from "bun:test";
import { DEAD_RESAMPLE_MS, probeDeadShellWindows, type DeadProbeDeps } from "../src/manager/list-dead-probe.ts";

const SHELL = "Last login: Thu Oct  8\nshawn@host repo % ";
const TUI = "╭───────╮\n│ ❯     │\n╰───────╯\n  ? for shortcuts";

/** panes[name] = [第一次采样, 第二次采样]；children[name] = 子进程探测结果 */
function fakeDeps(panes: Record<string, [string, string]>, children: Record<string, boolean | null>) {
  const calls = { capture: [] as string[], hasChild: [] as string[], sleeps: [] as number[] };
  const seen = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: DeadProbeDeps = {
    async capture(name) {
      calls.capture.push(name);
      const i = seen.get(name) ?? 0;
      seen.set(name, i + 1);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return panes[name]![Math.min(i, 1)]!;
    },
    async hasChild(name) {
      calls.hasChild.push(name);
      return children[name] ?? null;
    },
    async sleep(ms) {
      calls.sleeps.push(ms);
    },
  };
  return { deps, calls, maxInFlight: () => maxInFlight };
}

describe("probeDeadShellWindows", () => {
  test("25 个停在 shell 的窗口只睡一次、并行采样（旧实现逐个睡 800ms ≈ 20 秒）", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `agent-acp-${i}`);
    const f = fakeDeps(Object.fromEntries(names.map((n) => [n, [SHELL, SHELL]])), Object.fromEntries(names.map((n) => [n, true])));
    const dead = await probeDeadShellWindows(names, f.deps);
    expect(dead.size).toBe(0);
    expect(f.calls.sleeps).toEqual([DEAD_RESAMPLE_MS]);
    expect(f.calls.capture.length).toBe(50);
    expect(f.maxInFlight()).toBeGreaterThan(1);
  });

  test("没有窗口停在 shell 时不睡、不探子进程", async () => {
    const f = fakeDeps({ a: [TUI, TUI], b: [TUI, TUI] }, {});
    expect((await probeDeadShellWindows(["a", "b"], f.deps)).size).toBe(0);
    expect(f.calls.sleeps).toEqual([]);
    expect(f.calls.hasChild).toEqual([]);
  });

  test("判据不变：两次都在 shell 且确无子进程才算 dead；重绘过渡帧、有子进程、探测失败都不算", async () => {
    const f = fakeDeps(
      { dead: [SHELL, SHELL], redraw: [SHELL, TUI], acp: [SHELL, SHELL], unknown: [SHELL, SHELL], live: [TUI, TUI] },
      { dead: false, acp: true, unknown: null },
    );
    const dead = await probeDeadShellWindows(["dead", "redraw", "acp", "unknown", "live"], f.deps);
    expect([...dead]).toEqual(["dead"]);
    expect(f.calls.hasChild.sort()).toEqual(["acp", "dead", "unknown"]);
  });

  test("空候选直接返回", async () => {
    const f = fakeDeps({}, {});
    expect((await probeDeadShellWindows([], f.deps)).size).toBe(0);
    expect(f.calls.capture).toEqual([]);
  });
});
