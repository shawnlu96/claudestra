/**
 * 聊天气泡按 askId 认领「待你处理」（adv2 P2-2）：直播走出站事件的 askId，历史从 reply 的 tool_result 里解析；
 * 带了 id 只按 id 认，没带的授权类不按时间猜（旧气泡认成新 ask 会带着新参数那条的 id 去批）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { askForReply, type WebAsk } from "@/features/asks/asks-model";
import type { WebComponentRow } from "@/lib/chat/events";
import { toChatMessages } from "@/lib/chat/history-shape";
import { translate } from "@/lib/chat/stream-shape";
import { askIdOfReplyResult, replyResultText } from "../src/lib/reply-ask-schema.js";
import { readSessionHistory } from "../src/lib/session-history.js";

const rows: WebComponentRow[] = [{ type: "buttons", buttons: [{ id: "go", label: "批准" }, { id: "no", label: "算了" }] }];
const ask = (over: Partial<WebAsk>): WebAsk =>
  ({
    id: "ask_1", project: "p", taskId: null, fromAgent: "agent-x", source: "reply", kind: "decide", blocking: true, urgency: "normal", title: "t", context: "",
    body: "", options: rows, allowText: false, kindHint: null, expiresAt: 9e12, state: "open", answer: null, createdAt: 1_000_000, updatedAt: 1_000_000, ...over,
  }) as WebAsk;

describe("askForReply", () => {
  const A1 = ask({ id: "ask_a1", createdAt: 1_000_000, bind: { action: "release", params: { tag: "v2.0.1" } } });
  const A2 = ask({ id: "ask_a2", createdAt: 1_040_000, bind: { action: "release", params: { tag: "v2.0.2" } } });
  const late = new Date(1_025_000).toISOString(); // A1 的气泡晚到 25 秒：按时间最近会认成 A2

  test("带 askId：只按 id 认，时间怎么偏都不改；列表里没有就当没有", () => {
    expect(askForReply([A1, A2], "x", rows, late, [], "ask_a1")?.id).toBe("ask_a1");
    expect(askForReply([A1, A2], "x", rows, undefined, [], "ask_a1")?.id).toBe("ask_a1");
    expect(askForReply([A2], "x", rows, late, [], "ask_a1")).toBeNull();
  });

  test("没带 askId：授权类一律不认（bridge 同样 409）；非授权类照旧按形状 + 时间对", () => {
    expect(askForReply([A1, A2], "x", rows, late)).toBeNull();
    expect(askForReply([A1, A2], "x", rows, undefined)).toBeNull();
    expect(askForReply([ask({ id: "plain" })], "x", rows, late)?.id).toBe("plain");
  });
});

describe("askId 从哪来", () => {
  test("直播：出站 chat_message 带 askId（没有块级按钮、只有行内按钮的也带）", () => {
    const out = translate({ type: "chat_message", agent: "agent-x", seq: 1, ts: 0, data: { direction: "out", text: "发吗？[[{#go}批准]]", askId: "ask_a1" } } as never, "zh", new Set());
    expect(out).toMatchObject({ t: "reply", askId: "ask_a1" });
  });

  test("历史：reply 的 tool_result（replyResultText 那句）→ 气泡的 replyAskId；普通回复、失败的都没有", async () => {
    expect(askIdOfReplyResult({ content: [{ type: "text", text: replyResultText({ messageIds: ["m1"], askId: "ask_mz1abc", askHash: "h" }) }] })).toBe("ask_mz1abc");
    expect(askIdOfReplyResult({ content: replyResultText({ messageIds: ["m1"] }) })).toBeNull();
    expect(askIdOfReplyResult({ content: "Error: reply failed · ask ask_fake" })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "hist-ask-"));
    const p = join(dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    const reply = (id: string, text: string) => ({
      type: "assistant", timestamp: "2026-09-29T00:00:00Z", message: { content: [{ type: "tool_use", id, name: "mcp__claudestra__reply", input: { text, components: rows } }] },
    });
    const result = (id: string, r: Record<string, unknown>) => ({
      type: "user", timestamp: "2026-09-29T00:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: replyResultText(r) }] }] },
    });
    const lines = [reply("tu_1", "发 v2.0.1 吗"), result("tu_1", { messageIds: [], askId: "ask_a1" }), reply("tu_2", "好了"), result("tu_2", { messageIds: [] })];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const msgs = (await readSessionHistory(p)).messages.filter((m) => m.role === "assistant");
    expect(msgs.map((m) => m.replyAskId ?? null)).toEqual(["ask_a1", null]);
    const chat = toChatMessages(msgs as never).filter((m) => m.role === "assistant");
    expect(chat[0].replyAskId).toBe("ask_a1");
  });
});
