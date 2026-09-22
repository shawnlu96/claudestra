/**
 * 优雅退出的默认序列（runtimes/graceful-exit.ts，原 manager.gracefulExit 原样搬来）：
 * Claude Code / Pi 走默认清场——打断键 3 轮 + 守卫 Esc——按键与顺序逐字节不变。
 * Codex 的 exitPrelude 见 codex-exit.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { gracefulExitWindow } from "../src/lib/runtimes/graceful-exit.js";
import { managedFor, type WindowOps } from "../src/lib/runtimes/index.js";

/** 事件按发生顺序记：key:<名> / text:<字面> */
function scriptedWindow(panes: string[], kids: number[] = []) {
  const events: string[] = [];
  let i = 0;
  const win: WindowOps = {
    name: "agent-x",
    target: "master:agent-x",
    capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
    sendLine: async (t) => { events.push(`text:${t}`, "key:Enter"); },
    sendLiteral: async (t) => { events.push(`text:${t}`); },
    sendKey: async (k) => { events.push(`key:${k}`); },
    sendEscape: async () => { events.push("key:Escape"); },
    getOption: async () => null,
    setOption: async () => true,
    childPids: async () => kids,
    sleep: async () => {},
  };
  return { win, events };
}

describe("graceful-exit：Claude Code / Pi 的默认序列不变", () => {
  test("CC：C-c → 看到 ❯ 停 → 守卫 Esc → /exit + Enter → 回 shell", async () => {
    const ccIdle = "────────\n❯ \n────────\n  ? for shortcuts";
    const { win, events } = scriptedWindow([ccIdle, "~ %"]);
    expect(await gracefulExitWindow(win, managedFor("claude-code")!)).toBe(true);
    expect(events).toEqual(["key:C-c", "key:Escape", "text:/exit", "key:Enter"]);
  });

  test("Pi：C-c 三轮都没看到 ❯ → 守卫 Esc → /quit", async () => {
    const busy = "Working…";
    const { win, events } = scriptedWindow([busy, busy, busy, "~ %"]);
    expect(await gracefulExitWindow(win, managedFor("pi")!)).toBe(true);
    expect(events).toEqual(["key:C-c", "key:C-c", "key:C-c", "key:Escape", "text:/quit", "key:Enter"]);
  });

  test("打断阶段就回到 shell：不再发退出指令", async () => {
    const { win, events } = scriptedWindow(["~ %"]);
    expect(await gracefulExitWindow(win, managedFor("claude-code")!)).toBe(true);
    expect(events).toEqual(["key:C-c"]);
  });

  test("一直退不出去：强杀兜底 C-c / C-c / C-d，返回 false", async () => {
    const { win, events } = scriptedWindow(["Working…"]);
    expect(await gracefulExitWindow(win, managedFor("pi")!)).toBe(false);
    expect(events).toEqual(["key:C-c", "key:C-c", "key:C-c", "key:Escape", "text:/quit", "key:Enter", "key:C-c", "key:C-c", "key:C-d"]);
  });
});
