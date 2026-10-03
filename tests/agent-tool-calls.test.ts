/**
 * lib/agent-tool-calls.ts sendToAgentTool：押后时按 bridge 给的 heldBy 如实告诉发送方——撞墙菜单上没发键、额度闸押着，
 * 不能说成「对方在忙」；没有 heldBy 的排队照旧。
 * 正文校验：text 缺失 / 非字符串 / 空白当场报错、不调 bridge；误传 message 提示参数名是 text，不回显正文。
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

describe("sendToAgentTool 正文校验", () => {
  const spy = () => {
    const calls: any[] = [];
    const br = async (msg: any) => { calls.push(msg); return { targetName: "agent-x", pushBack: true }; };
    return { calls, br };
  };

  for (const [name, args] of [
    ["缺失 text", { target: "x" }],
    ["text 为 null", { target: "x", text: null }],
    ["text 非字符串", { target: "x", text: 42 }],
    ["text 为空串", { target: "x", text: "" }],
    ["text 纯空白", { target: "x", text: " \n\t " }],
  ] as const) {
    test(`${name}：当场报错，不调 bridge`, async () => {
      const { calls, br } = spy();
      const out: any = await sendToAgentTool(br, args);
      expect(calls).toHaveLength(0);
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain("text");
      expect(out.content[0].text).not.toContain("消息已发送");
      expect(calls).toHaveLength(0);
    });
  }

  test("只给 message：提示参数名是 text，不当作 text 投递、不回显正文", async () => {
    const { calls, br } = spy();
    const out: any = await sendToAgentTool(br, { target: "x", message: "secret-body-123" });
    expect(calls).toHaveLength(0);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("message");
    expect(out.content[0].text).toContain("text");
    expect(out.content[0].text).not.toContain("secret-body-123");
    expect(calls).toHaveLength(0);
  });

  test("合法 text 原样投递（首尾空白、换行、中文），其余字段不变", async () => {
    const { calls, br } = spy();
    const text = "  你好\n第二行  ";
    const out: any = await sendToAgentTool(br, { target: "x", text, expecting: "reply", oneShot: true });
    expect(out.isError).toBeUndefined();
    expect(calls).toEqual([{ type: "route_to_agent", targetName: "x", text, expecting: "reply", oneShot: true }]);
  });
});
