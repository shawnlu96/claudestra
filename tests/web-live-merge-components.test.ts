/**
 * 差量续接（mergeContiguousAssistant）拼组件后，与整段拉历史（toChatMessages）的结果一致：
 * 同一回合被切成两段先后到达时，按钮 / 表单一个不丢，已答键、回投还原、可同步表单都和刷新后一样。
 * T10b 审查的 S1–S6 场景。
 */
import { describe, expect, test } from "bun:test";
import { toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";
import { mergeContiguousAssistant } from "@/features/chat/live-merge";
import { openForms } from "@/lib/chat/form-open";
import { syncBlock, toggleFormValue } from "@/lib/chat/form-compose";
import type { ChatMessage } from "@/features/chat/type";
import type { WebComponentRow } from "@/lib/chat/events";

const btn = (...ids: string[]): WebComponentRow => ({ type: "buttons", buttons: ids.map((id) => ({ id, label: `L${id}` })) });
const form = (id: string, vals = ["a", "b"]): WebComponentRow => ({ type: "multiselect", id, placeholder: `P${id}`, options: vals.map((v) => ({ label: `O${v}`, value: v })) });
const A = (seq: number, comps: WebComponentRow[]): NeutralMessage => ({ seq, role: "assistant", text: `t${seq}`, replyText: `r${seq}`, replyComponents: comps });
const U = (seq: number, text: string): NeutralMessage => ({ seq, role: "user", text });
// toChatMessages 会就地回填 replyClicks，每次给一份新拷贝
const shape = (items: NeutralMessage[]) => toChatMessages(JSON.parse(JSON.stringify(items)) as NeutralMessage[], { sid: "s" });
const live = (split: number, items: NeutralMessage[]) => mergeContiguousAssistant(shape(items.slice(0, split)), shape(items.slice(split)));
const pick = (ms: ChatMessage[]) =>
  ms.map((m) => ({ id: m.id, role: m.role, comps: m.replyComponents?.length, clicks: m.replyClicks, content: m.role === "user" ? m.content : undefined }));

describe("差量续接 = 整段刷新", () => {
  test("S1 前一段已答多选 + 后一段未答按钮：已答保留，表单不再可同步", () => {
    const base = shape([A(1, [form("f")])]);
    base[0].replyClicks = { "m:f": "f:a" };
    const merged = mergeContiguousAssistant(base, shape([A(2, [btn("go")])]));
    expect(merged[0].replyComponents).toHaveLength(2);
    expect(merged[0].replyClicks).toEqual({ "m:f": "f:a" });
    expect(openForms(merged)).toHaveLength(0);
  });

  test("S2 点的是后一段的按钮（回投在差量里）", () => {
    const items = [A(1, [btn("x"), form("f")]), A(2, [btn("y")]), U(3, "[button:y]")];
    expect(pick(live(1, items))).toEqual(pick(shape(items)));
    expect(live(1, items)[0].replyClicks).toEqual({ b2: "y" });
  });

  test("S3 同一按钮 id 在前后两段都出现：两边都认最新那段（b1）", () => {
    const items = [A(1, [btn("ok")]), A(2, [btn("ok")]), U(3, "[button:ok]")];
    expect(pick(live(1, items))).toEqual(pick(shape(items)));
    expect(shape(items)[0].replyClicks).toEqual({ b1: "ok" });
  });

  test("S4 后一段的多选被答（select 回投还原成可读行）", () => {
    const items = [A(1, [btn("x")]), A(2, [form("f")]), U(3, "[select:f:a,b]")];
    expect(pick(live(1, items))).toEqual(pick(shape(items)));
    expect(shape(items)[1].content).toBe("【Pf】✓ Oa；✓ Ob");
  });

  test("S6 三段续接（两次差量）", () => {
    const items = [A(1, [btn("x")]), A(2, [btn("y")]), A(3, [btn("z")]), U(4, "[button:z]")];
    const step1 = mergeContiguousAssistant(shape(items.slice(0, 1)), shape(items.slice(1, 2)));
    const step2 = mergeContiguousAssistant(step1, shape(items.slice(2)));
    expect(pick(step2)).toEqual(pick(shape(items)));
  });
});

describe("S5 同一回合前后两段复用多选表单 id", () => {
  const items = [A(1, [form("f", ["a", "b"])]), A(2, [form("f", ["c", "d"])])];
  for (const [name, msgs] of [["差量续接", live(1, items)], ["整段刷新", shape(items)]] as const) {
    test(`${name}：最新那行同步、勾得进输入框；旧的那行退回本地（superseded）`, () => {
      const m = msgs[0];
      const forms = openForms(msgs);
      const [head, tail] = [m.replyComponents![0], m.replyComponents![1]] as Extract<WebComponentRow, { type: "multiselect" }>[];
      const tailForm = forms.find((f) => f.messageId === m.id && f.rowIndex === 1)!;
      const headForm = forms.find((f) => f.messageId === m.id && f.rowIndex === 0)!;
      expect(tailForm.row.options.map((o) => o.value)).toEqual(["c", "d"]);
      expect(syncBlock(tail, tailForm, forms, true)).toBeNull();
      expect(toggleFormValue("", tailForm, forms, "c")).toBe("【Pf】✓ Oc\n");
      expect(syncBlock(head, headForm, forms, true)).toBe("superseded");
    });
  }
});
