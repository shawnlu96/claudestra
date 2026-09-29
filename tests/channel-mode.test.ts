/**
 * channel-server 没有 DISCORD_CHANNEL_ID 时的行为（用户自己开的 CC 会话也会因用户级
 * MCP 注册拉起它）。以前 exit(1) → 用户 /mcp 里常驻「claudestra ✘ failed」。
 * 现在是 inert：握手照常、0 工具、不声明 channel、不连 bridge、只在 stdio 关闭时退出。
 */
import { describe, test, expect } from "bun:test";
import { channelServerMode, inertNotice, mcpCapabilities, shouldConnectBridge } from "../src/lib/channel-mode.js";
import { etimeSeconds, olderSiblingChannelServers } from "../src/lib/codex-thread.js";
import { decideAfterReplaced } from "../src/lib/link-policy.js";

describe("channelServerMode", () => {
  test("有频道 id → 正常频道会话", () => {
    expect(channelServerMode({ DISCORD_CHANNEL_ID: "123" })).toBe("channel");
  });
  test("没有 / 空串 → inert（不退出）", () => {
    expect(channelServerMode({})).toBe("inert");
    expect(channelServerMode({ DISCORD_CHANNEL_ID: "" })).toBe("inert");
  });
  test("Codex 子 agent 线程那份（同一个 Codex 进程里已有更早的 channel-server）→ inert，不和主线程对抢频道", () => {
    const codex = { DISCORD_CHANNEL_ID: "local-1", CLAUDESTRA_RUNTIME: "codex" };
    expect(channelServerMode(codex, () => true)).toBe("inert");
    expect(channelServerMode(codex, () => false)).toBe("channel");
    expect(inertNotice(codex)).toContain("子 agent");
    expect(inertNotice({})).toContain("没有 DISCORD_CHANNEL_ID");
  });
  test("Claude Code 会话不查兄弟进程（探针不被调用）", () => {
    let called = false;
    expect(channelServerMode({ DISCORD_CHANNEL_ID: "123" }, () => (called = true))).toBe("channel");
    expect(called).toBe(false);
  });
});

describe("olderSiblingChannelServers：认出同一个 Codex 进程里更早的那份", () => {
  const bin = "/Users/x/.bun/bin/bun /Users/x/repos/claudestra/src/../src/channel-server.ts";
  // 2026-09-29 实测形状：主线程那份 13:40 起，spawn_agent 那一秒多出第二份
  const ps = [
    `21252 19921    02:10:00 /opt/codex resume 01a0ebad --dangerously-bypass-approvals-and-sandbox`,
    `21291 21252    02:09:59 ${bin}`,
    `35861 21252    01:36:30 ${bin}`,
    ` 3849  3796 06-23:19:36 bun run /Users/x/repos/claudestra/src/channel-server.ts`,
  ].join("\n");
  test("子线程那份看得到主线程那份；主线程那份看不到比它更早的", () => {
    expect(olderSiblingChannelServers(ps, { pid: 35861, ppid: 21252 })).toEqual([21291]);
    expect(olderSiblingChannelServers(ps, { pid: 21291, ppid: 21252 })).toEqual([]);
  });
  test("别的父进程下的 channel-server、非 channel-server 的兄弟不算", () => {
    expect(olderSiblingChannelServers(ps, { pid: 3849, ppid: 3796 })).toEqual([]);
    expect(olderSiblingChannelServers(`${ps}\n40000 21252    03:00:00 node other-mcp.js`, { pid: 21291, ppid: 21252 })).toEqual([]);
  });
  test("同一秒起的按 pid 定先后；自己不在 ps 里 → 不认（退回老行为）", () => {
    const same = `100 9    00:05 ${bin}\n101 9    00:05 ${bin}`;
    expect(olderSiblingChannelServers(same, { pid: 101, ppid: 9 })).toEqual([100]);
    expect(olderSiblingChannelServers(same, { pid: 100, ppid: 9 })).toEqual([]);
    expect(olderSiblingChannelServers(ps, { pid: 999, ppid: 21252 })).toEqual([]);
  });
  test("etimeSeconds 认 mm:ss / hh:mm:ss / dd-hh:mm:ss", () => {
    expect(etimeSeconds("00:05")).toBe(5);
    expect(etimeSeconds("01:36:30")).toBe(5790);
    expect(etimeSeconds("06-23:19:36")).toBe(6 * 86400 + 23 * 3600 + 19 * 60 + 36);
    expect(etimeSeconds("abc")).toBeNaN();
  });
});

describe("inert 会话的对外形状", () => {
  test("不声明 claude/channel，CC 不会以为能收推送", () => {
    expect(mcpCapabilities("inert")).toEqual({ tools: {} });
    expect(mcpCapabilities("channel").experimental).toEqual({ "claude/channel": {} });
  });
  test("不连 bridge（握手回调和 30s 兜底都不连）", () => {
    expect(shouldConnectBridge("inert")).toBe(false);
    expect(shouldConnectBridge("channel")).toBe(true);
  });
  test("link-policy 的不变量不受影响：stdio 连着就绝不退出", () => {
    expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 1 }).action).toBe("reconnect");
    expect(decideAfterReplaced({ mcpClosed: true, consecutiveReplaced: 1 }).action).toBe("exit");
  });
});
