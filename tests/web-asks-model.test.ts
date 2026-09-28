/** web/features/asks/asks-model.ts：分组计数、气泡 ↔ ask 对应、已答回填、答案人话、时间文案；以及 stream-shape 的作答回显只留原文 */
import { describe, expect, test } from "bun:test";
import { answerSummary, askCounts, askForReply, clicksFromAnswer, groupAsks, spanText, type WebAsk } from "@/features/asks/asks-model";
import type { WebComponentRow } from "@/lib/chat/events";
import { translate } from "@/lib/chat/stream-shape";
import { fillParams } from "@/lib/i18n-fill";

const rows: WebComponentRow[] = [
  { type: "buttons", buttons: [{ id: "go", label: "发" }, { id: "no", label: "不发" }] },
  { type: "multiselect", id: "f", options: [{ label: "甲", value: "a" }, { label: "乙", value: "b" }] },
];
const ask = (over: Partial<WebAsk>): WebAsk => ({
  id: "ask_1", project: "p", taskId: null, fromAgent: "agent-x", source: "reply", kind: "decide", blocking: null, urgency: "normal",
  title: "t", context: "", body: "", options: rows, allowText: true, kindHint: null, expiresAt: 9e12, state: "open", answer: null,
  createdAt: 1_000_000, updatedAt: 1_000_000, ...over,
});
const zh = (s: string, p?: Record<string, string | number>) => fillParams(s, p);

describe("分组与计数", () => {
  test("开着的按等待时长排、验收单列；已结案的新的在前；入口数字不含验收", () => {
    const list = [
      ask({ id: "b", createdAt: 2 }), ask({ id: "a", createdAt: 1 }), ask({ id: "v", kind: "accept" }),
      ask({ id: "old", state: "answered", updatedAt: 5 }), ask({ id: "new", state: "expired", updatedAt: 9 }),
    ];
    const g = groupAsks(list);
    expect(g.waiting.map((a) => a.id)).toEqual(["a", "b"]);
    expect(g.accept.map((a) => a.id)).toEqual(["v"]);
    expect(g.recent.map((a) => a.id)).toEqual(["new", "old"]);
    expect(askCounts(list)).toEqual({ waiting: 2, accept: 1 });
  });
});

describe("气泡 ↔ ask", () => {
  const ts = new Date(1_000_500).toISOString();
  test("同一个 agent（bridge 名 / 前端名都认）、选项以气泡 components 开头（后面可跟行内按钮）", () => {
    const a = ask({ options: [...rows, { type: "buttons", buttons: [{ id: "inline", label: "x" }] }] });
    expect(askForReply([a], "x", rows, ts)?.id).toBe("ask_1");
    expect(askForReply([a], "y", rows, ts)).toBeNull();
    expect(askForReply([a], "x", [rows[0]], ts)?.id).toBe("ask_1");
    expect(askForReply([a], "x", [rows[1]], ts)).toBeNull();
    expect(askForReply([ask({ fromAgent: "master" })], "__master__", rows, ts)?.id).toBe("ask_1");
  });

  test("复用同一组按钮：取建立时间离气泡最近的；超过两分钟不认", () => {
    const list = [ask({ id: "early", createdAt: 0 }), ask({ id: "near", createdAt: 1_000_000 })];
    expect(askForReply(list, "x", rows, ts)?.id).toBe("near");
    expect(askForReply(list, "x", rows, new Date(10_000_000).toISOString())).toBeNull();
    expect(askForReply(list, "x", rows)?.id).toBe("near");
  });

  test("答案回填成 replyClicks：按钮行存 id，选单行存 `<id>:<值>`", () => {
    expect(clicksFromAnswer(rows, ["[button:no]", "[select:f:a,b]"])).toEqual({ b0: "no", "m:f": "f:a,b" });
    expect(clicksFromAnswer(rows, ["[button:zzz]"])).toEqual({});
  });

  test("答案人话：wire 换成按钮 / 选项文字，接上 owner 的话", () => {
    const a = ask({ state: "answered", answer: { choices: ["[button:go]", "[select:f:b]"], text: "先别打 tag", via: "web_card", at: 1 } });
    expect(answerSummary(a)).toBe("发；乙；「先别打 tag」");
  });
});

test("时间文案", () => {
  expect(spanText(10_000, zh)).toBe("不到 1 分钟");
  expect(spanText(12 * 60_000, zh)).toBe("12 分钟");
  expect(spanText(3 * 3600_000, zh)).toBe("3 小时");
  expect(spanText(3 * 86400_000, zh)).toBe("3 天");
});

test("作答回显：去掉给 agent 看的第一行，只留 owner 发的原文（才对得上乐观气泡）", () => {
  const evt = { seq: 1, ts: "", agent: "agent-x", chatId: "c", type: "chat_message", data: { direction: "in", srcKind: "api", text: "[✅ owner 回复了你 …]\n[button:go]", askId: "ask_1" } };
  expect(translate(evt as never, "zh", new Set())).toMatchObject({ t: "user-in", text: "[button:go]" });
});
