/**
 * 聊天气泡按 askId 认领「待你处理」（adv2 P2-2）：直播走出站事件的 askId，历史从 reply 的 tool_result 里解析；
 * 带了 id 只按 id 认，没带的授权类不按时间猜（旧气泡认成新 ask 会带着新参数那条的 id 去批）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { askForReply, unclaimedBindAsk, type WebAsk } from "@/features/asks/asks-model";
import { mergeContiguousAssistant } from "@/features/chat/live-merge";
import type { ChatMessage } from "@/features/chat/type";
import type { WebComponentRow } from "@/lib/chat/events";
import { splitsReplyBubble, toChatMessages } from "@/lib/chat/history-shape";
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

  test("没认出的授权气泡：列表里有同形状、开着的授权类 → unclaimedBindAsk 给出它，按钮锁住去卡片上批（adv3 P2-2）", () => {
    expect(unclaimedBindAsk([A1, A2], "x", rows)?.id).toBe("ask_a1");
    expect(unclaimedBindAsk([{ ...A1, state: "answered" }], "x", rows)).toBeNull(); // 结案的不算
    expect(unclaimedBindAsk([ask({ id: "plain" })], "x", rows)).toBeNull(); // 非授权类照旧按时间认，不锁
    expect(unclaimedBindAsk([A1], "y", rows)).toBeNull(); // 别的 agent 的
    expect(unclaimedBindAsk([A1], "x", [{ type: "buttons", buttons: [{ id: "ok", label: "好" }] }])).toBeNull(); // 形状不同
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

describe("一个气泡最多一条带按钮的 reply（adv3 P1：两条带 ask 的并成一泡，前一段的「批准」会批新参数）", () => {
  const inline = (tag: string) => `发 ${tag} 吗？[[{#rel_go}批准]] [[{#rel_no}算了]]`;

  test("规则本身：两边都带按钮才分；纯文字 reply 照旧并进去（直播 setReplyText 用的就是它）", () => {
    expect(splitsReplyBubble({ replyText: inline("v2.0.1") }, inline("v2.0.2"))).toBe(true);
    expect(splitsReplyBubble({ replyComponents: rows }, "好了", rows)).toBe(true);
    expect(splitsReplyBubble({ replyText: inline("v2.0.1") }, "顺带说一句")).toBe(false);
    expect(splitsReplyBubble({ replyText: "先看一下" }, inline("v2.0.2"))).toBe(false);
  });

  test("历史：同一回合 v2.0.1、v2.0.2 两条 reply → 两个气泡，各自的「批准」各批各的（行内、块级都一样）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-two-ask-"));
    const p = join(dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    const rec = (role: string, content: unknown[]) => ({ type: role, timestamp: "2026-09-29T00:00:00Z", message: { content } });
    const reply = (id: string, input: Record<string, unknown>) => rec("assistant", [{ type: "tool_use", id, name: "mcp__claudestra__reply", input }]);
    const result = (id: string, askId: string) =>
      rec("user", [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: replyResultText({ messageIds: [], askId }) }] }]);
    const lines = [
      reply("tu_1", { text: inline("v2.0.1") }), result("tu_1", "ask_a1"),
      reply("tu_2", { text: inline("v2.0.2") }), result("tu_2", "ask_a2"),
      reply("tu_3", { text: "块级", components: rows }), result("tu_3", "ask_b1"),
      reply("tu_4", { text: "块级 2", components: rows }), result("tu_4", "ask_b2"),
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const hist = (await readSessionHistory(p)).messages;
    const chat = toChatMessages(hist as never).filter((m) => m.role === "assistant");
    expect(chat.map((m) => [m.replyAskId, m.replyComponents?.length ?? 0])).toEqual([["ask_a1", 0], ["ask_a2", 0], ["ask_b1", 1], ["ask_b2", 1]]);
    const asks = ["ask_a1", "ask_a2", "ask_b1", "ask_b2"].map((id) => ask({ id, bind: { action: "release", params: { id } } }));
    for (const m of chat) expect(askForReply(asks, "x", m.replyComponents, m.replyTs, m.replyComponents ? [] : ["rel_go", "rel_no"], m.replyAskId)?.id).toBe(m.replyAskId!);
  });

  test("差量拼接：尾泡和差量首泡都带按钮就不并（与整段拉历史同一口径）；有一边没按钮照旧并", () => {
    const b = (id: string, over: Partial<ChatMessage>): ChatMessage =>
      ({ id, role: "assistant", content: "", sid: "s", seqEnd: Number(id.slice(1)), segments: [{ kind: "reply", text: over.replyText ?? "" }], ...over }) as ChatMessage;
    const last = b("h1", { replyText: inline("v2.0.1"), replyAskId: "ask_a1" });
    expect(mergeContiguousAssistant([last], [b("h3", { replyText: inline("v2.0.2"), replyAskId: "ask_a2" })]).map((m) => m.replyAskId)).toEqual(["ask_a1", "ask_a2"]);
    expect(mergeContiguousAssistant([last], [b("h3", { replyText: "好了" })]).map((m) => m.replyAskId)).toEqual(["ask_a1"]);
  });
});
