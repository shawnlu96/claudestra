/**
 * i28-R5a r1 P1-1 回归：真 tmux（私有 socket）里，宿主不在第一个 pane 也算活着，lend 循环不杀它；宿主退了 / 窗口没了照常判出来。
 * 步骤在 tests/worker-liveness-tmux-child.ts（要在子进程里换 tmux socket）。CI 装了 tmux，没有时这条会失败，不静默跳过。
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

test("分屏后宿主在 pane 1：running，两轮循环不杀；杀宿主 = no_host，kill-window = no_window", async () => {
  // socket 路径有长度上限（macOS 104 字节），不用可能很长的 TMPDIR
  const dir = mkdtempSync("/tmp/r5a-tmux-");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "worker-liveness-tmux-child.ts")],
    { env: testChildEnv({ CLAUDESTRA_RUNTIME_DIR: dir, CLAUDESTRA_STATE_DIR: join(dir, "state") }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
    single: "running", split: "running", loop: { state: "started", killed: [] }, hostKilled: "no_host", windowKilled: "no_window",
  });
}, 30_000);
