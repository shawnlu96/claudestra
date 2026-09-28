/**
 * S7：差量里回投前一段的按钮 / 表单，实时视图要和刷新后一样——显示可读文案、原表单标已答（web/features/chat/delta-clicks.ts）。
 * 做法：同一串记录整段整形（= 刷新后）与「前一段 + 差量」分开整形再 resolveDeltaClicks，两边结果逐条对齐。
 */
import { describe, expect, test } from "bun:test";
import { toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";
import { liveUserText, resolveDeltaClicks, resolveLiveClick, resolvePendingClicks } from "@/features/chat/delta-clicks";
import { composeView } from "@/features/chat/view-compose";
import type { ChatMessage } from "@/features/chat/type";
import type { WebComponentRow } from "@/lib/chat/events";

const u = (seq: number, text: string, extra: Partial<NeutralMessage> = {}): NeutralMessage => ({ seq, role: "user", text, ...extra });
const a = (seq: number, extra: Partial<NeutralMessage> = {}): NeutralMessage => ({ seq, role: "assistant", ...extra });

const FORM: WebComponentRow[] = [
  { type: "buttons", buttons: [{ id: "go", label: "✅ 发版" }, { id: "no", label: "🚫 取消" }] },
  { type: "select", id: "env", options: [{ label: "预发", value: "stg" }, { label: "线上", value: "prod" }] },
  {
    type: "multiselect",
    id: "picks",
    placeholder: "选要做的",
    options: [{ label: "写测试", value: "t" }, { label: "截图", value: "s" }, { label: "发版", value: "r" }],
  },
];

/** 前一段：带表单的回复；差量：用户的回投（+ 可选的后续）。返回整段整形与分段整形 + 解析后的两份结果 */
function split(prior: NeutralMessage[], delta: NeutralMessage[]) {
  const clone = <T>(x: T): T => structuredClone(x);
  const full = toChatMessages(clone([...prior, ...delta]), { sid: "s1" });
  const base = toChatMessages(clone(prior), { sid: "s1" });
  const shaped = toChatMessages(clone(delta), { sid: "s1" });
  const before = shaped.map((m) => m.content);
  resolveDeltaClicks(base, shaped);
  return { full, base, shaped, before };
}

const prior = [u(1, "发版吗"), a(2, { replyText: "要发哪些？", replyComponents: FORM })];

describe("resolveDeltaClicks（差量里的回投往前找所属表单）", () => {
  test("按钮：差量单独整形只能兜底「🔘 go」，接上前一段后还原成按钮文案，并给原表单标已答", () => {
    const r = split(prior, [u(3, "[button:go]")]);
    expect(r.before).toEqual(["🔘 go"]); // 修之前实时视图看到的就是这个
    expect(r.shaped[0].content).toBe("✅ 发版");
    expect(r.shaped[0].clickRaw).toBeUndefined();
    expect(r.base[1].replyClicks).toEqual(r.full[1].replyClicks!);
    expect(r.base[1].replyClicks).toEqual({ b0: "go" });
  });

  test("单选：按 id 找到前一段的选单", () => {
    const r = split(prior, [u(3, "[select:env:prod]")]);
    expect(r.before).toEqual(["🔘 prod"]);
    expect(r.shaped[0].content).toBe(r.full[2].content);
    expect(r.shaped[0].content).toBe("线上");
    expect(r.base[1].replyClicks).toEqual(r.full[1].replyClicks!);
  });

  test("多选表单的整段回投：还原成「【标题】✓ …」，与刷新后一致", () => {
    const r = split(prior, [u(3, "[select:picks:t,s]")]);
    expect(r.shaped[0].content).toBe(r.full[2].content);
    expect(r.shaped[0].content).toContain("【");
    expect(r.base[1].replyClicks).toEqual(r.full[1].replyClicks!);
    expect(Object.keys(r.base[1].replyClicks ?? {})).toHaveLength(1);
  });

  test("差量里既有回投、又有 agent 的后续回复：只动回投那条，后续气泡原样", () => {
    const r = split(prior, [u(3, "[button:no]"), a(4, { replyText: "好，取消了" })]);
    expect(r.shaped.map((m) => m.content)).toEqual(r.full.slice(2).map((m) => m.content));
    expect(r.shaped[1].replyText).toBe("好，取消了");
  });

  test("差量里自己就带了表单：整形时已经解析好，不留 clickRaw，也不去碰前一段", () => {
    const r = split([u(1, "hi")], [a(2, { replyText: "选", replyComponents: FORM }), u(3, "[button:go]")]);
    expect(r.before[1]).toBe("✅ 发版");
    expect(r.shaped[1].clickRaw).toBeUndefined();
    expect(r.base[0].replyClicks).toBeUndefined();
  });

  test("前一段里也找不到（表单比已加载的还早）：维持兜底文案、留着 clickRaw；往上翻页加载出表单后补上", () => {
    const r = split([u(10, "hi"), a(11, { text: "没有表单" })], [u(12, "[button:go]")]);
    expect(r.shaped[0].content).toBe("🔘 go");
    expect(r.shaped[0].clickRaw).toBe("[button:go]");
    // loadOlder：更早的一页（带表单）拼到前面
    const older = toChatMessages(structuredClone(prior), { sid: "s1", tail: false });
    const list = resolvePendingClicks([...older, ...r.base, ...r.shaped]);
    expect(list.at(-1)!.content).toBe("✅ 发版");
    expect(list.at(-1)!.clickRaw).toBeUndefined();
    expect(older[1].replyClicks).toEqual({ b0: "go" });
  });

  test("P1-1：带 emoji 字段的按钮，本端乐观气泡 +「差量回投」对账后只剩一份（显示文案与按钮上的一致）", () => {
    const form: WebComponentRow[] = [{ type: "buttons", buttons: [{ id: "go", label: "发版", emoji: "✅" }] }];
    const base = toChatMessages([u(1, "发版吗"), a(2, { replyText: "发吗", replyComponents: form })], { sid: "s1" });
    const local: ChatMessage = { id: "local1", role: "user", content: "✅ 发版", wire: "[button:go]", local: true, ts: new Date().toISOString() };
    const delta = toChatMessages([u(3, "[button:go]")], { sid: "s1" });
    const history = [...base, ...resolveDeltaClicks(base, delta)];
    const v = composeView({ current: [...base, local], history, incoming: delta, streaming: false, cursor: null });
    expect(v.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["发版吗", "✅ 发版"]);
    // 整段刷新也是同一个文案
    const full = toChatMessages([u(1, "发版吗"), a(2, { replyText: "发吗", replyComponents: form }), u(3, "[button:go]")]);
    expect(full[2].content).toBe("✅ 发版");
  });

  test("同 id 表单复用：实时通道已给后一张标了同一个答案，差量再解析同一条回投时不挪到更早那张", () => {
    const two = [...prior, u(3, "再来一张"), a(4, { replyText: "同一个表单再发一次", replyComponents: FORM })];
    const base = toChatMessages(structuredClone(two), { sid: "s1" });
    expect(resolveLiveClick("[select:picks:t,s]", base)).toContain("【");
    expect(base[3].replyClicks).toEqual({ "m:picks": "picks:t,s" });
    const delta = toChatMessages([u(5, "[select:picks:t,s]")], { sid: "s1" });
    resolveDeltaClicks(base, delta);
    expect(delta[0].content).toContain("【");
    expect(base[1].replyClicks).toBeUndefined(); // 更早那张没被误标
    expect(base[3].replyClicks).toEqual({ "m:picks": "picks:t,s" });
  });

  test("按钮认最近的锚点：两段都有表单时，回投落在更近的那一段（与整段整形同一规则）", () => {
    const later: WebComponentRow[] = [{ type: "buttons", buttons: [{ id: "go", label: "✅ 再发一次" }] }];
    const r = split([...prior, u(3, "先等等"), a(4, { replyText: "那这样？", replyComponents: later })], [u(5, "[button:go]")]);
    expect(r.shaped[0].content).toBe("✅ 再发一次");
    expect(r.shaped[0].content).toBe(r.full[4].content);
    expect(r.base[1].replyClicks).toBeUndefined();
    expect(r.base[3].replyClicks).toEqual({ b0: "go" });
  });

  test("普通文字消息不受影响；别的设备 / 访客点的也一样还原（整段整形不分来源，实时视图也不分）", () => {
    const r = split(prior, [u(3, "随便说点")]);
    expect(r.shaped[0].content).toBe("随便说点");
    expect(r.shaped[0].clickRaw).toBeUndefined();
    const guest = split(prior, [u(3, "[button:go]", { from: "guest-mom", fromId: "api:guest:mom" })]);
    expect(guest.shaped[0].content).toBe("✅ 发版");
    expect(guest.shaped[0].from).toBe("guest-mom");
  });
});

describe("resolveLiveClick（实时流推来的他端回投）", () => {
  test("按钮 / 单选 / 多选都还原成与刷新后一样的文案，并给表单标已答；普通文字返回 null", () => {
    for (const [wire, idx] of [["[button:go]", 2], ["[select:env:stg]", 2], ["[select:picks:r]", 2]] as const) {
      const msgs = toChatMessages(structuredClone(prior), { sid: "s1" });
      const full = toChatMessages(structuredClone([...prior, u(3, wire)]), { sid: "s1" });
      expect(resolveLiveClick(wire, msgs)).toBe(full[idx].content);
      expect(msgs[1].replyClicks).toEqual(full[1].replyClicks!);
    }
    expect(resolveLiveClick("随便说点", toChatMessages(structuredClone(prior)))).toBeNull();
  });

  test("liveUserText：还原过的保留原文在 wire（回声对账用），普通文字不带 wire", () => {
    expect(liveUserText("[button:go]", toChatMessages(structuredClone(prior)))).toEqual({ content: "✅ 发版", wire: "[button:go]" });
    expect(liveUserText("随便说点", toChatMessages(structuredClone(prior)))).toEqual({ content: "随便说点" });
  });

  test("表单不在当前列表里：按钮给兜底「🔘 id」（与刷新后同形），不是原样的 [button:id]", () => {
    expect(resolveLiveClick("[button:ghost]", toChatMessages([u(1, "hi")]))).toBe("🔘 ghost");
  });
});
