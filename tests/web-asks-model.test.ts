/** web/features/asks/asks-model.ts：分组计数、气泡 ↔ ask 对应、已答回填、答案人话、时间文案、乐观作答；以及 stream-shape 的作答回显只留原文 */
import { describe, expect, test } from "bun:test";
import {
  agentLabel, answeredGroups, answerSummary, applyPending, askAttachments, askCounts, askForReply, clicksFromAnswer, closedText,
  groupAsks, PENDING_MAX_MS, rowGroup, spanText, waitsOnOwner, wireLabels, type PendingAnswer, type WebAsk,
} from "@/features/asks/asks-model";
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

  test("等你处理：急的在前，卡活的其次，同档里等得久的在前", () => {
    const g = groupAsks([ask({ id: "old", createdAt: 1 }), ask({ id: "blk", blocking: true, createdAt: 5 }), ask({ id: "urg", urgency: "urgent", createdAt: 9 })]);
    expect(g.waiting.map((a) => a.id)).toEqual(["urg", "blk", "old"]);
  });

  test("大总管显示成人话，不露内部名", () => {
    expect(agentLabel("master", (s) => s)).toBe("大总管");
    expect(agentLabel("agent-x", (s) => s)).toBe("x");
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

  test("只有行内按钮的气泡也认得出（按 id 对 bridge 合成的最后一行）：点之前才带得上 askId", () => {
    const inline = ask({ id: "inl", options: [{ type: "buttons", buttons: [{ id: "go", label: "批准", style: "success" }, { id: "no", label: "算了" }] }] });
    expect(askForReply([inline], "x", [], ts, ["go", "no"])?.id).toBe("inl");
    expect(askForReply([inline], "x", undefined, ts, ["go"])).toBeNull();
    expect(askForReply([inline], "x", [], ts)).toBeNull();
  });

  test("字段顺序不同也认（历史接口按 agent 的参数顺序给，ask 里存的是 bridge 收到时的顺序）", () => {
    const shuffled = [rows[0], { options: (rows[1] as { options: unknown[] }).options, id: "f", type: "multiselect" }] as WebComponentRow[];
    expect(askForReply([ask({})], "x", shuffled, ts)?.id).toBe("ask_1");
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

  test("答案人话：用 bridge 记下的按钮 / 选项文字，接上 owner 的话；老数据没有 labels 退回 wire", () => {
    const a = ask({ state: "answered", answer: { choices: ["[button:go]", "[select:f:b]"], labels: ["发", "乙"], text: "先别打 tag", via: "web_card", at: 1 } });
    expect(answerSummary(a)).toBe("发；乙；「先别打 tag」");
    expect(answerSummary(ask({ answer: { choices: ["[button:go]"], text: "", via: "x", at: 1 } }))).toBe("[button:go]");
  });

  test("按组判断哪些行答过了：每一行各一组，按钮行按行号（同 bridge 的 answerGroups）", () => {
    const more: WebComponentRow[] = [...rows, { type: "buttons", buttons: [{ id: "later", label: "再说" }] }];
    expect(more.map(rowGroup)).toEqual(["buttons:0", "select:f", "buttons:2"]);
    expect([...answeredGroups(more, ["[button:later]"])]).toEqual(["buttons:2"]);
    expect([...answeredGroups(more, ["[select:f:a]", "[button:go]"])].sort()).toEqual(["buttons:0", "select:f"]);
  });
});

test("时间文案", () => {
  expect(spanText(10_000, zh)).toBe("不到 1 分钟");
  expect(spanText(12 * 60_000, zh)).toBe("12 分钟");
  expect(spanText(3 * 3600_000, zh)).toBe("3 小时");
  expect(spanText(3 * 86400_000, zh)).toBe("3 天");
});

test("作答回显：bridge 给了 echo 就显示它（选项人话 + 原话），带上 askId 给引用条；老 bridge 没 echo 的只去掉第一行", () => {
  const data = { direction: "in", srcKind: "api", text: "[✅ owner 回复了你 …]\n[button:go]", askId: "ask_1" };
  const evt = (d: Record<string, unknown>) => ({ seq: 1, ts: "", agent: "agent-x", chatId: "c", type: "chat_message", data: d }) as never;
  expect(translate(evt({ ...data, echo: "发\n只发 Codex" }), "zh", new Set())).toMatchObject({ t: "user-in", text: "发\n只发 Codex", askId: "ask_1" });
  expect(translate(evt(data), "zh", new Set())).toMatchObject({ t: "user-in", text: "[button:go]", askId: "ask_1" });
});

test("原消息带的附件 → 卡片上的附件条（图片 / 文件、inbox 的地址）", () => {
  const files = [{ name: "a.png", attachment: "1_a.png" }, { name: "稿子.md", attachment: "2_稿子.md" }];
  const got = askAttachments({ extra: { files } }).map((x) => [x.name, x.kind, x.url.endsWith("1_a.png") || x.url.includes(encodeURIComponent("2_稿子.md"))]);
  expect(got).toEqual([["a.png", "image", true], ["稿子.md", "file", true]]);
  expect(askAttachments({})).toEqual([]);
});

describe("乐观作答（T11b 第 8 条）", () => {
  const shown: PendingAnswer["answer"] = { choices: [], labels: ["发"], text: "", via: "web_card", at: 5_000 };
  const pend = (at = 5_000) => new Map([["ask_1", { at, answer: shown }]]);

  test("提交那一刻：服务端还说开着，本地先显示已答——移出「等你处理」、计数减 1，卡上已答是提交的人话", () => {
    const server = [ask({ id: "ask_1" }), ask({ id: "ask_2" })];
    const v = applyPending(server, pend(), 5_100);
    expect(v.settled).toEqual([]);
    expect(askCounts(v.asks).waiting).toBe(1);
    expect(groupAsks(v.asks).recent.map((a) => a.id)).toEqual(["ask_1"]);
    expect(answerSummary(v.asks[0])).toBe("发");
  });

  test("服务端确认（已不是 open）、列表里没了、或盖了太久：settled，此后以服务端为准（盖太久的回到「等你处理」）", () => {
    const answered = ask({ id: "ask_1", state: "answered", answer: { choices: ["[button:go]"], labels: ["发"], text: "好", via: "web_card", at: 5_050 } });
    expect(applyPending([answered], pend(), 5_100)).toMatchObject({ settled: ["ask_1"], asks: [{ answer: { text: "好" } }] });
    expect(applyPending([], pend(), 5_100).settled).toEqual(["ask_1"]);
    const stale = applyPending([ask({ id: "ask_1" })], pend(), 5_000 + PENDING_MAX_MS + 1);
    expect(stale.settled).toEqual(["ask_1"]);
    expect(askCounts(stale.asks).waiting).toBe(1);
  });

  test("请求还在飞的不按时间撤；多行 reply 已答的几行和这次的合在一起显示（PR0 r1 P2-2、P2-5）", () => {
    const inFlight = new Map([["ask_1", { ...pend().get("ask_1")!, inFlight: true }]]);
    expect(applyPending([ask({ id: "ask_1" })], inFlight, 5_000 + PENDING_MAX_MS * 3).settled).toEqual([]);
    const part = ask({ id: "ask_1", answer: { choices: ["[select:f:a]"], labels: ["甲"], text: "", via: "web_chat", at: 4_000 } });
    expect(applyPending([part], pend(), 5_100).asks[0].answer).toMatchObject({ choices: ["[select:f:a]"], labels: ["甲", "发"] });
  });

  test("wire → 人话：按钮取文字，选单取选中项文字（多选用「、」），对不上的原样", () => {
    expect(wireLabels(rows, ["[button:go]", "[select:f:a,b]", "[button:zz]"])).toEqual(["发", "甲、乙", "[button:zz]"]);
  });
});

describe("第二版（T11b PR A）", () => {
  test("协作视图的「等你」不算指给 guest 的指派事项（r1 P2-2）", () => {
    expect([ask({}), ask({ assignee: "local:owner:self" }), ask({ assignee: "local:guest:aa11", kind: "assigned" }), ask({ kind: "accept" })].map(waitsOnOwner)).toEqual([true, true, false, false]);
  });

  test("人 / 系统发起的没有 agent：卡片按类型写「指派」「审核」；聊天气泡永远对不上它；被取代的写「已被新版本取代」", () => {
    expect(agentLabel(null, (x) => x, "assigned")).toBe("指派");
    expect(agentLabel(null, (x) => x, "decide")).toBe("审核");
    expect(askForReply([ask({ fromAgent: null, source: "human" })], "x", rows)).toBeNull();
    expect(closedText(ask({ state: "superseded" }), (x) => x)).toBe("已被新版本取代");
    expect(groupAsks([ask({ state: "superseded" })]).recent).toHaveLength(1);
  });
});
