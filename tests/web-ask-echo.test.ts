/**
 * owner 对「待你处理」的作答在网页上的样子（T11b PR B r1 的 P2-1 / P2-2）：bridge 把 wire 行换成了选项人话（lib/inbound-body.ts answerEcho），
 * 原文另放 wire——直播回声按原文和乐观气泡对账（不再闪两个气泡），历史 / 直播都按原文回填所答气泡的已答态；只写了字答的，ask 移出列表后按已结案锁住——都不会把旧点击再发给 agent。
 */
import { describe, expect, test } from "bun:test";
import { answerEcho } from "../src/lib/inbound-body.js";
import { unwrapChannelMessage } from "../src/lib/session-history.js";
import { askAnchor, toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";
import { translate } from "@/lib/chat/stream-shape";
import { isUserEcho } from "@/features/chat/view-compose";
import { liveAnswerText } from "@/features/chat/delta-clicks";
import type { ChatMessage } from "@/features/chat/type";
import { replyAskState, type WebAsk } from "@/features/asks/asks-model";

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

describe("ask 移出列表后（结案超过 3 天）点旧按钮不会发出 [button:…]（PM 定的 P2-2 锁定用例）", () => {
  const NOW = Date.parse("2026-10-05T00:00:00Z");
  const old = { replyText: "要部署吗？", replyComponents: comps, replyTs: "2026-09-29T00:00:01Z", ts: "2026-09-29T00:00:01Z", replyAskId: "ask_1" };

  test("按按钮答的：历史按原文回填了已答态，那一行本来就点不了（reply-components 的 clicks[rowKey] 已有值）", () => {
    const out = toChatMessages([{ seq: 1, role: "assistant", ...old }, { seq: 2, role: "user", text: "部署", askId: "ask_1", wire: "[button:deploy]" }], { selfIds: SELF });
    expect(out[0].replyClicks?.b0).toBe("deploy");
  });

  test("只写了字答的（没有可回填的按钮）：列表已加载却查不到、气泡比保留期旧 → 按已结案锁住，beforeSend 不发", () => {
    const s = replyAskState([], "ok", "agent-x", old, [], NOW);
    expect([s.gone, s.blocked]).toEqual([true, true]);
  });

  test("Pi / Codex / 老历史的气泡不带 askId：同样按已结案锁住", () => {
    expect(replyAskState([], "ok", "agent-x", { ...old, replyAskId: undefined }, [], NOW)).toMatchObject({ gone: true, blocked: true, hintId: null });
  });

  test("列表靠不住时不按天数猜，改让 bridge 按气泡自带的 askId 判（已结案回 409）", () => {
    // 还在加载 / 没有台账权限（403，列表恒空）/ 列表只取 200 条、3 天内结案的被挤出去
    for (const list of ["loading", "denied"] as const) expect(replyAskState([], list, "agent-x", old, [], NOW)).toMatchObject({ gone: false, blocked: false, hintId: "ask_1" });
    const fresh = { ...old, replyTs: "2026-10-04T12:00:00Z" };
    expect(replyAskState([], "ok", "agent-x", fresh, [], NOW)).toMatchObject({ blocked: false, hintId: "ask_1" });
    // 还在加载、气泡又没带 askId：没法让 bridge 判，先不让发
    expect(replyAskState([], "loading", "agent-x", { ...old, replyAskId: undefined }, [], NOW).blocked).toBe(true);
    expect(replyAskState([], "denied", "agent-x", { ...old, replyAskId: undefined }, [], NOW).blocked).toBe(false);
  });

  test("不误锁：气泡在保留期内（刚建还没刷到）、ask 还在列表里开着、没有按钮的气泡", () => {
    expect(replyAskState([], "ok", "agent-x", { ...old, replyAskId: undefined, replyTs: "2026-10-04T12:00:00Z" }, [], NOW).blocked).toBe(false);
    const open = { id: "ask_1", state: "open", source: "reply", fromAgent: "agent-x", options: comps, createdAt: Date.parse(old.replyTs) } as unknown as WebAsk;
    expect(replyAskState([open], "ok", "agent-x", old, [], NOW)).toMatchObject({ gone: false, blocked: false, ask: { id: "ask_1" }, hintId: "ask_1" });
    expect(replyAskState([], "ok", "agent-x", { ...old, replyComponents: undefined }, [], NOW).blocked).toBe(false);
  });
});
