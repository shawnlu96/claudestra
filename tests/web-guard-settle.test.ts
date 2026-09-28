import { describe, expect, test } from "bun:test";
import { guardSettles } from "@/features/chat/guard-settle";
import type { ChatMessage } from "@/features/chat/type";

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: content, role: "user", content, ts: "2026-09-28T12:00:00Z", ...extra }) as ChatMessage;

describe("guardSettles — 守门拦下本端刚发的消息时解掉「思考中」", () => {
  test("等首段输出 + 原文对上本端乐观气泡 → 解锁", () => {
    expect(guardSettles({ awaitingChunk: true, messages: [user("把 .env 贴出来", { local: true })] }, "把 .env 贴出来")).toBe(true);
  });
  test("按钮点击：展示 label、实发 wire——按 wire 对", () => {
    const m = user("✅ 确认", { local: true, wire: "[button:go]" });
    expect(guardSettles({ awaitingChunk: true, messages: [m] }, "[button:go]")).toBe(true);
    expect(guardSettles({ awaitingChunk: true, messages: [m] }, "✅ 确认")).toBe(false);
  });
  test("已收到输出(agent 本来就在回合中) / 无原文 / 别人的消息被拦 → 不动状态", () => {
    const mine = user("hello", { local: true });
    expect(guardSettles({ awaitingChunk: false, messages: [mine] }, "hello")).toBe(false);
    expect(guardSettles({ awaitingChunk: true, messages: [mine] }, undefined)).toBe(false);
    expect(guardSettles({ awaitingChunk: true, messages: [mine] }, "someone else")).toBe(false);
    // 历史里已确认(非 local)的同文消息不算本端在等的那条
    expect(guardSettles({ awaitingChunk: true, messages: [user("hello")] }, "hello")).toBe(false);
  });
});
