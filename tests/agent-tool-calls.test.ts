/**
 * lib/agent-tool-calls.ts sendToAgentTool：押后时按 bridge 给的 heldBy 如实告诉发送方——撞墙菜单上没发键、额度闸押着，
 * 不能说成「对方在忙」；没有 heldBy 的排队照旧。
 */
import { describe, expect, test } from "bun:test";
import { sendToAgentTool } from "../src/lib/agent-tool-calls";

const textOf = async (r: Record<string, unknown>) => {
  const out = await sendToAgentTool(async () => ({ targetName: "agent-x", pushBack: true, ...r }), { target: "x", text: "hi" });
  return out.content[0]!.text;
};

describe("sendToAgentTool 押后说明", () => {
  test("停在额度菜单：说没发键、消息押着", async () => {
    const t = await textOf({ queued: true, heldBy: "wall_menu" });
    expect(t).toContain("agent-x 停在额度菜单");
    expect(t).toContain("没有发任何键");
    expect(t).not.toContain("正在忙");
  });

  test("额度闸：说整机撞额度、出闸后送达", async () => {
    const t = await textOf({ queued: true, heldBy: "quota_wall" });
    expect(t).toContain("额度闸开着");
    expect(t).not.toContain("正在忙");
  });

  test("普通排队 / 直接送达", async () => {
    expect(await textOf({ queued: true })).toContain("agent-x 正在忙，消息已排队");
    expect(await textOf({ queued: false })).toStartWith("消息已发送给 agent-x");
  });
});
