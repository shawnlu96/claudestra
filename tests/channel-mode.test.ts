/**
 * channel-server 没有 DISCORD_CHANNEL_ID 时的行为（用户自己开的 CC 会话也会因用户级
 * MCP 注册拉起它）。以前 exit(1) → 用户 /mcp 里常驻「claudestra ✘ failed」。
 * 现在是 inert：握手照常、0 工具、不声明 channel、不连 bridge、只在 stdio 关闭时退出。
 */
import { describe, test, expect } from "bun:test";
import { channelServerMode, mcpCapabilities, shouldConnectBridge } from "../src/lib/channel-mode.js";
import { decideAfterReplaced } from "../src/lib/link-policy.js";

describe("channelServerMode", () => {
  test("有频道 id → 正常频道会话", () => {
    expect(channelServerMode({ DISCORD_CHANNEL_ID: "123" })).toBe("channel");
  });
  test("没有 / 空串 → inert（不退出）", () => {
    expect(channelServerMode({})).toBe("inert");
    expect(channelServerMode({ DISCORD_CHANNEL_ID: "" })).toBe("inert");
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
