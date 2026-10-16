/**
 * 网页直播侧的 API 错误：assistant_text 带 apiError / rateLimited 翻成 notice（不进 agent 气泡），
 * notice 画成一行系统提示、和上一条相同就并成 ×N。（额度闸那一行的显示模型挪到 tests/web-quota-notice-model.test.ts。）
 */
import { describe, expect, test } from "bun:test";
import { mergeContiguousAssistant } from "@/features/chat/live-merge";
import { pushNotice } from "@/features/chat/notice-merge";
import type { ChatMessage } from "@/features/chat/type";
import { translate, type BridgeEvent } from "@/lib/chat/stream-shape";

const LIMIT = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const ev = (data: Record<string, unknown>): BridgeEvent => ({ seq: 1, ts: "", agent: "a", chatId: "c", type: "assistant_text", data }) as BridgeEvent;

describe("直播 notice", () => {
  test("apiError / rateLimited 的文本翻成 notice，普通文本照旧", () => {
    expect(translate(ev({ text: LIMIT, apiError: true, seq: 7, sid: "s" }), "zh", new Set())).toEqual({ t: "notice", text: LIMIT, seq: 7, sid: "s" });
    expect(translate(ev({ text: "You've hit your usage limit.", rateLimited: true }), "zh", new Set())).toMatchObject({ t: "notice" });
    expect(translate(ev({ text: "看下代码" }), "zh", new Set())).toMatchObject({ t: "text", text: "看下代码" });
  });

  test("连续相同的并成 ×N；中间隔了别的消息就另起一条", () => {
    const m: ChatMessage[] = [];
    pushNotice(m, LIMIT, "1", "t1");
    pushNotice(m, LIMIT, "2", "t2");
    pushNotice(m, LIMIT, "3", "t3");
    expect(m).toEqual([{ id: "1", role: "system", content: `⛔ ×3 ${LIMIT}`, ts: "t3" }]);
    m.push({ id: "u", role: "user", content: "接着做", ts: "t4" });
    pushNotice(m, LIMIT, "5", "t5");
    expect(m.map((x) => x.content)).toEqual([`⛔ ×3 ${LIMIT}`, "接着做", `⛔ ${LIMIT}`]);
    pushNotice(m, "API Error: 500", "6", "t6");
    expect(m.at(-1)!.content).toBe("⛔ API Error: 500");
  });
});

describe("差量拼接遇到同一串 ⛔ 错误行（T24 wf notify-web-rules-4）", () => {
  test("服务端重算的 ×2 那行替换尾条，不追加成「⛔ X」+「⛔ ×2 X」两行", () => {
    const base: ChatMessage[] = [{ id: "h1", role: "system", content: `⛔ ${LIMIT}`, ts: "" }];
    const delta: ChatMessage[] = [{ id: "h3", role: "system", content: `⛔ ×2 ${LIMIT}`, ts: "" }];
    expect(mergeContiguousAssistant(base, delta).map((m) => m.content)).toEqual([`⛔ ×2 ${LIMIT}`]);
    const other: ChatMessage[] = [{ id: "h4", role: "system", content: "⛔ API Error: 529", ts: "" }];
    expect(mergeContiguousAssistant(base, other)).toHaveLength(2);
  });
});
