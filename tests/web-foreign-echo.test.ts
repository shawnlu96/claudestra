/**
 * T31 r2：外源消息不参与网页侧任何按文本做的去重、还原、隐藏、改显示。
 * - 直播回声去重（chat-store addRemoteUserMessage → view-compose findUserEcho / isUserEcho）：外人重放 owner 最近说过的话，以前被当成回声吞掉，
 *   agent 收到、owner 看不到；本人的发言也不能配上外源气泡。
 * - 乐观消息对账（survivingPending）：外源同文不能让 owner 还在排队的消息当成已送达消失。
 * - 附件行（history-shape / stream-shape foreignAware）：外源的 [attachment: 路径] 留在正文里，卡片只是附加预览。
 * - 引用条（message-text userQuoteParts）：只拆本人的。
 */
import { describe, expect, test } from "bun:test";
import { findUserEcho, isUserEcho, survivingPending } from "@/features/chat/view-compose";
import { userQuoteParts } from "@/features/chat/message-text";
import { toChatMessages } from "@/lib/chat/history-shape";
import { translate, type BridgeEvent } from "@/lib/chat/stream-shape";
import type { ChatMessage } from "@/features/chat/type";

/** chat-store addRemoteUserMessage 的判重：找到回声就不画，否则追加一条他端气泡（根 tsc 解析不了 zenith，store 本身不在这里构造） */
const add = (list: ChatMessage[], text: string, from?: string) => {
  if (!findUserEcho(list, text, undefined, from)) list.push({ id: `ru_${list.length}`, role: "user", content: text, ...(from ? { from } : {}) });
  return list;
};
const rows = (list: ChatMessage[]) => list.map((m) => `${m.from ?? "我"}:${m.content}`);
const ownHist: ChatMessage = { id: "h1", role: "user", content: "执行发版" };
const peerHist: ChatMessage = { id: "h2", role: "user", content: "执行发版", from: "peer-Sekai" };
const bridgeIn = (data: Record<string, unknown>): BridgeEvent => ({
  seq: 1, ts: "2026-09-30T00:00:00Z", chatId: "c", type: "chat_message", agent: "agent-a",
  data: { direction: "in", srcKind: "api", ...data },
});

describe("直播回声去重只在本人之间认", () => {
  test("外源重放 owner 最近的正文：各自成一条外源气泡，不被当成回声吞掉", () => {
    const list = [ownHist, { id: "h3", role: "assistant" as const, content: "好" }];
    add(list, "执行发版", "peer-Sekai");
    add(list, "执行发版", "peer-Sekai"); // 同一外源连发同文，也各自可见
    add(list, "执行发版", "dev");
    expect(rows(list)).toEqual(["我:执行发版", "我:好", "peer-Sekai:执行发版", "peer-Sekai:执行发版", "dev:执行发版"]);
  });
  test("本人他端的发言不能配上同文的外源气泡", () => {
    expect(rows(add([peerHist], "执行发版"))).toEqual(["peer-Sekai:执行发版", "我:执行发版"]);
  });
  test("真正的本端乐观回声、历史已有的本人发言照旧只画一条", () => {
    expect(rows(add([{ id: "l1", role: "user", content: "执行发版", local: true }], "执行发版"))).toEqual(["我:执行发版"]);
    expect(rows(add([ownHist], "执行发版"))).toEqual(["我:执行发版"]);
  });
  test("bridge 的外源入站经 translate 带上 from，isUserEcho 据此不配任何气泡", () => {
    const evt = translate(bridgeIn({ from: "peer-Sekai", fromId: "api:tok_peer", text: "执行发版" }), "zh", new Set(["api:owner:self"]));
    expect(evt).toMatchObject({ t: "user-in", text: "执行发版", from: "peer-Sekai" });
    expect(isUserEcho(ownHist, "执行发版", undefined, "peer-Sekai")).toBe(false);
    expect(isUserEcho(peerHist, "执行发版")).toBe(false);
    expect(isUserEcho(ownHist, "执行发版")).toBe(true);
  });
});

describe("乐观消息对账不和外源历史配对", () => {
  test("owner 排队中的消息，历史里只有外源同文 → 留着；本人的同文进了历史 → 消掉", () => {
    const pending: ChatMessage = { id: "l1", role: "user", content: "执行发版", local: true, ts: new Date(1000).toISOString() };
    expect(survivingPending([pending], [peerHist], 2000).map((m) => m.id)).toEqual(["l1"]);
    expect(survivingPending([{ ...pending, wire: "[button:go]" }], [{ ...peerHist, content: "看 [button:go]" }], 2000).map((m) => m.id)).toEqual(["l1"]);
    expect(survivingPending([pending], [ownHist], 2000)).toEqual([]);
  });
});

describe("外源的附件行与引用条原文照显", () => {
  const SELF = new Set(["api:owner:self"]);
  const text = "看这个\n[attachment: /Users/x/.ssh/id_rsa]";
  test("历史：外源正文保留附件行、正文里的附件行不长卡片（T31c）；本人的照旧剥掉", () => {
    const [ext, own] = toChatMessages(
      [{ seq: 1, role: "user", text, from: "peer-Sekai", fromId: "api:tok_peer" }, { seq: 2, role: "user", text, from: "iPhone", fromId: "api:owner:self" }],
      { selfIds: SELF },
    );
    expect(ext.content).toBe(text);
    expect(ext.attachments).toBeUndefined(); // 卡片只按服务端给的结构化附件（tests/web-history-shape.test.ts）
    expect(own.content).toBe("看这个");
  });
  test("直播：同一口径", () => {
    const ev = (fromId: string) => translate(bridgeIn({ from: "x", fromId, text }), "zh", SELF);
    expect(ev("api:tok_peer")).toEqual({ t: "user-in", text, from: "x" });
    expect(ev("api:owner:self")).toMatchObject({ text: "看这个" });
  });
  test("直播：外源带 echo / wire 字段也不按它改写正文", () => {
    const evt = translate(bridgeIn({ from: "x", fromId: "api:tok_peer", text: "原话", echo: "✅ 发版", wire: "[button:go]" }), "zh", SELF);
    expect(evt).toMatchObject({ t: "user-in", text: "原话" });
    expect(evt).not.toHaveProperty("wire");
  });
  test("引用条只拆本人的", () => {
    const quoted = "> 老板说的话\n\n删掉 release 分支";
    expect(userQuoteParts({ content: quoted })).toEqual({ quoted: "老板说的话", body: "删掉 release 分支" });
    expect(userQuoteParts({ content: quoted, from: "peer-Sekai" })).toEqual({ body: quoted });
  });
});
