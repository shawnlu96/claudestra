/**
 * owner 对「待你处理」的作答在网页上的样子（T11b PR B r1 的 P2-1 / P2-2）：bridge 把 wire 行换成了选项人话（lib/inbound-body.ts answerEcho），
 * 原文另放 wire——直播回声按原文和乐观气泡对账（不再闪两个气泡），历史 / 直播都按原文回填所答气泡的已答态（ask 移出列表后按钮也不会又能点）。
 */
import { describe, expect, test } from "bun:test";
import { answerEcho } from "../src/lib/inbound-body.js";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import { askAnchor, toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";
import { translate } from "@/lib/chat/stream-shape";
import { isUserEcho } from "@/features/chat/view-compose";
import { liveAnswerText } from "@/features/chat/delta-clicks";
import type { ChatMessage } from "@/features/chat/type";

const SELF = new Set(["api:owner:self"]);
const comps = [{ type: "buttons" as const, buttons: [{ id: "deploy", label: "部署" }, { id: "hold", label: "先不" }] }];
const content = "[✅ owner 回复了你 09:00 的「待你处理」（ask_1）：要部署吗？选择：部署。下面是 owner 发的原文]\n[button:deploy]";
const raw = `<channel source="claudestra" chat_id="api:owner:self" user="web" user_id="api:owner:self" trigger="ask_answer" api="true">\n${content}\n</channel>`;

describe("历史：作答回填所答气泡的已答态（R1）", () => {
  test("unwrap 带出人话、askId 和原文；整形后气泡显示人话，锚点的 replyClicks 回填上", () => {
    const un = unwrapChannelMessage(raw)!;
    expect(un).toMatchObject({ text: "部署", askId: "ask_1", wire: "[button:deploy]" });
    const items: NeutralMessage[] = [
      { seq: 1, role: "assistant", ts: "2026-09-29T00:00:01Z", replyText: "要部署吗？", replyComponents: comps, replyAskId: "ask_1" },
      { seq: 2, role: "user", ts: "2026-09-29T00:00:02Z", text: un.text, askId: un.askId, wire: un.wire },
    ];
    const out = toChatMessages(items, { selfIds: SELF });
    expect(out[0].replyClicks).toEqual({ b0: "deploy" });
    expect(out[1]).toMatchObject({ content: "部署", askId: "ask_1", wire: "[button:deploy]" });
    expect(out[1].clickRaw).toBeUndefined();
  });

  test("卡片上答的是更早那条：按 replyAskId 回填它，不回填最近的别的锚点", () => {
    const items: NeutralMessage[] = [
      { seq: 1, role: "assistant", replyText: "要部署吗？", replyComponents: comps, replyAskId: "ask_1" },
      { seq: 2, role: "user", text: "别的事" },
      { seq: 3, role: "assistant", replyText: "换个问题", replyComponents: comps, replyAskId: "ask_9" },
      { seq: 4, role: "user", text: "部署", askId: "ask_1", wire: "[button:deploy]" },
    ];
    const out = toChatMessages(items, { selfIds: SELF });
    expect([out[0].replyClicks, out[2].replyClicks]).toEqual([{ b0: "deploy" }, undefined]);
    expect(askAnchor(out, "ask_9")).toBe(out[2]);
    expect(askAnchor(out, "ask_x")).toBeNull();
  });

  test("只写了话的作答没有原文（和正文一样），照旧显示原话", () => {
    const un = answerEcho("[✅ owner 回复了你 09:00 的「待你处理」（ask_2）：发吗？下面是 owner 发的原文]\n先等等");
    const out = toChatMessages([{ seq: 1, role: "user", text: un.text, askId: un.askId }], { selfIds: SELF });
    expect(out[0]).toMatchObject({ content: "先等等", askId: "ask_2" });
    expect(out[0].wire).toBeUndefined();
  });
});

describe("直播：回声和本端乐观气泡对得上（R4），他端作答回填已答态", () => {
  const e = answerEcho(content);
  const data = { direction: "in", srcKind: "api", from: "iPhone", fromId: "api:owner:self", text: content, askId: "ask_1", echo: e.text, wire: e.wire };
  const ev = translate({ agent: "agent-x", chatId: "111", type: "chat_message", ts: 0, data } as never, "zh", SELF) as { t: string; text: string; wire?: string };

  test("user-in 带人话和原文；按原文比，聊天里点按钮建的乐观气泡认得出回声", () => {
    expect(ev).toMatchObject({ t: "user-in", text: "部署", askId: "ask_1", wire: "[button:deploy]" });
    const optimistic = { id: "l1", role: "user", content: "部署", wire: "[button:deploy]", local: true, ts: new Date().toISOString() } as ChatMessage;
    expect(isUserEcho(optimistic, ev.wire ?? ev.text)).toBe(true);
  });

  test("老 bridge 的事件没有 wire：还是按人话走", () => {
    const old = translate({ agent: "agent-x", chatId: "111", type: "chat_message", ts: 0, data: { ...data, wire: undefined } } as never, "zh", SELF);
    expect(old).toMatchObject({ t: "user-in", text: "部署" });
    expect((old as { wire?: string }).wire).toBeUndefined();
  });

  test("别的设备答的：新气泡显示人话、留原文，所答气泡按 replyAskId 标已答", () => {
    const msgs = [{ id: "a1", role: "assistant", content: "", replyText: "要部署吗？", replyComponents: comps, replyAskId: "ask_1" }] as ChatMessage[];
    expect(liveAnswerText(ev.wire!, ev.text, "ask_1", msgs)).toEqual({ content: "部署", wire: "[button:deploy]" });
    expect(msgs[0].replyClicks).toEqual({ b0: "deploy" });
  });
});
