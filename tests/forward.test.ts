import { describe, expect, test } from "bun:test";
import { forwardHeader, forwardNotice, forwardVerdict, isForwardTool, type ForwardCheck } from "../src/lib/forward";

const ok: ForwardCheck = {
  srcKind: "api", forwarded: false, fromAgent: "agent-gc-car", target: "agent-gc-car-chat",
  targetExists: true, targetOnline: true, targetIsMaster: false, inScope: true,
};

describe("forwardVerdict（转交的护栏）", () => {
  test("Web / Discord 用户发错了对象 → 可以转", () => {
    expect(forwardVerdict(ok)).toBeNull();
    expect(forwardVerdict({ ...ok, srcKind: "user" })).toBeNull();
  });
  test("最多一跳：转过来的消息不能再转（防来回踢皮球）", () => {
    expect(forwardVerdict({ ...ok, forwarded: true })).toContain("转过一次");
  });
  test("peer 的请求、agent 之间的消息不能转", () => {
    expect(forwardVerdict({ ...ok, peer: "HedeMacBook-Pro" })).toContain("peer");
    expect(forwardVerdict({ ...ok, srcKind: "local" })).toContain("用户直接发来");
  });
  test("不转给自己、不转给大总管、目标要存在 / 在线 / 在用户权限内", () => {
    expect(forwardVerdict({ ...ok, target: "agent-gc-car" })).toContain("自己");
    expect(forwardVerdict({ ...ok, target: "master", targetIsMaster: true })).toContain("大总管");
    expect(forwardVerdict({ ...ok, targetExists: false })).toContain("找不到");
    expect(forwardVerdict({ ...ok, inScope: false })).toContain("权限");
    expect(forwardVerdict({ ...ok, targetOnline: false })).toContain("不在线");
  });
});

describe("文案与工具名", () => {
  test("原对话的提示是可点的 agent 跳转，去掉 agent- 前缀", () => {
    expect(forwardNotice("agent-gc-car-chat")).toBe("↪ 已转给 [[{.agent}gc-car-chat]]");
  });
  test("接手方看到的说明：谁转来、为什么、直接回用户、不能再转", () => {
    const h = forwardHeader("gc-car", "问的是聊天机器人");
    expect(h).toContain("由 gc-car 转来");
    expect(h).toContain("问的是聊天机器人");
    expect(h).toContain("不能再转");
  });
  test("Claude Code 的 MCP 名与 Pi 的裸名都认", () => {
    expect(isForwardTool("mcp__claudestra__forward_to_agent")).toBe(true);
    expect(isForwardTool("forward_to_agent")).toBe(true);
    expect(isForwardTool("mcp__claudestra__send_to_agent")).toBe(false);
  });
});
