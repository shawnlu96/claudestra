/**
 * T10 多选表单 ↔ 输入框同步行的纯逻辑：生成、解析、就地更新、发送转换、历史还原。
 * 输入框文字是唯一事实来源——勾选状态从文字解析，这里锁住解析的无歧义与就地更新不伤草稿。
 */
import { describe, expect, test } from "bun:test";
import {
  composeFormSend,
  formTitles,
  parseFormLine,
  pickedFromText,
  renderFormLine,
  setFormValues,
  toggleFormValue,
  wireToDisplay,
  type MultiRow,
  type OpenForm,
} from "@/lib/chat/form-compose";
import { toChatMessages, type NeutralMessage } from "@/lib/chat/history-shape";

const design: MultiRow = {
  type: "multiselect",
  id: "d_t8_design_form",
  placeholder: "T8 设计怎么定（可多选）",
  options: [
    { label: "按 v3 开工", value: "v3" },
    { label: "夜里只在线上出问题时叫醒我", value: "night_wake" },
    { label: "先出原型", value: "proto" },
  ],
};
const T = "T8 设计怎么定（可多选）";
const LINE = `【${T}】✓ 按 v3 开工；✓ 夜里只在线上出问题时叫醒我`;

describe("formTitles", () => {
  test("有 placeholder 用 placeholder，没有退回 id", () => {
    const t = formTitles([design, { type: "multiselect", id: "bare", options: [] }]);
    expect(t.get("d_t8_design_form")).toBe(T);
    expect(t.get("bare")).toBe("bare");
  });
  test("不同表单 placeholder 重名 → placeholder · id；同一 id 出现两次不算重名", () => {
    const a: MultiRow = { type: "multiselect", id: "t9_scope", placeholder: "请选择", options: [] };
    const b: MultiRow = { type: "multiselect", id: "t9_alert", placeholder: "请选择", options: [] };
    const t = formTitles([a, b, design, design]);
    expect(t.get("t9_scope")).toBe("请选择 · t9_scope");
    expect(t.get("t9_alert")).toBe("请选择 · t9_alert");
    expect(t.get("d_t8_design_form")).toBe(T);
  });
});

describe("renderFormLine / parseFormLine", () => {
  test("按选中顺序渲染；空集合 = 空串", () => {
    expect(renderFormLine(design, T, ["v3", "night_wake"])).toBe(LINE);
    expect(renderFormLine(design, T, [])).toBe("");
  });
  test("往返一致", () => {
    expect(parseFormLine(LINE, design, T)).toEqual({ values: ["v3", "night_wake"], rest: "" });
  });
  test("锚点按 placeholder / id / placeholder · id 都认", () => {
    for (const a of [T, "d_t8_design_form", `${T} · d_t8_design_form`]) {
      expect(parseFormLine(`【${a}】✓ 先出原型`, design, T)?.values).toEqual(["proto"]);
    }
  });
  test("别的表单的行、普通文字 → null", () => {
    expect(parseFormLine("【别的表单】✓ 按 v3 开工", design, T)).toBeNull();
    expect(parseFormLine("随便说一句", design, T)).toBeNull();
  });
  test("label 里带 ；、placeholder 里带 】 也不切错", () => {
    const row: MultiRow = {
      type: "multiselect",
      id: "x",
      placeholder: "选【一个】或多个",
      options: [{ label: "甲；乙", value: "ab" }, { label: "丙", value: "c" }],
    };
    const title = "选【一个】或多个";
    const line = renderFormLine(row, title, ["ab", "c"]);
    expect(line).toBe("【选【一个】或多个】✓ 甲；乙；✓ 丙");
    expect(parseFormLine(line, row, title)?.values).toEqual(["ab", "c"]);
  });
  test("label 是另一个 label 的前缀：最长匹配 + 边界检查", () => {
    const row: MultiRow = { type: "multiselect", id: "p", options: [{ label: "A", value: "a" }, { label: "AB", value: "ab" }] };
    expect(parseFormLine("【p】✓ AB；✓ A", row, "p")?.values).toEqual(["ab", "a"]);
    expect(parseFormLine("【p】✓ ABC", row, "p")).toEqual({ values: [], rest: "✓ ABC" });
  });
  test("行尾接着打的字算补充（rest）", () => {
    expect(parseFormLine(`${LINE} 另外周三前给稿`, design, T)).toEqual({ values: ["v3", "night_wake"], rest: "另外周三前给稿" });
  });
});

describe("toggle / setFormValues（就地更新不伤草稿）", () => {
  test("空输入框：写入一行并补换行，光标落在下一行", () => {
    expect(toggleFormValue("", design, T, "v3")).toBe(`【${T}】✓ 按 v3 开工\n`);
  });
  test("已有草稿：另起一行追加，原草稿不动", () => {
    expect(toggleFormValue("先说一句", design, T, "v3")).toBe(`先说一句\n【${T}】✓ 按 v3 开工\n`);
    expect(toggleFormValue("先说一句\n", design, T, "v3")).toBe(`先说一句\n【${T}】✓ 按 v3 开工\n`);
  });
  test("再勾一项：就地改那一行，前后文字不动", () => {
    const before = `开头\n【${T}】✓ 按 v3 开工\n补充一句`;
    expect(toggleFormValue(before, design, T, "night_wake")).toBe(`开头\n${LINE}\n补充一句`);
  });
  test("取消：移除那一项；全取消删行；只剩这一行时清空", () => {
    expect(toggleFormValue(`${LINE}\n补充`, design, T, "v3")).toBe(`【${T}】✓ 夜里只在线上出问题时叫醒我\n补充`);
    expect(toggleFormValue(`开头\n【${T}】✓ 按 v3 开工\n补充`, design, T, "v3")).toBe("开头\n补充");
    expect(toggleFormValue(`【${T}】✓ 按 v3 开工\n`, design, T, "v3")).toBe("");
  });
  test("行尾补充随行保留", () => {
    expect(toggleFormValue(`【${T}】✓ 按 v3 开工 周三前`, design, T, "proto")).toBe(`【${T}】✓ 按 v3 开工；✓ 先出原型 周三前`);
    expect(setFormValues(`【${T}】✓ 按 v3 开工 周三前`, design, T, [])).toBe("周三前");
  });
  test("超过 max 的勾选不生效", () => {
    const row = { ...design, max: 1 };
    const one = toggleFormValue("", row, T, "v3");
    expect(toggleFormValue(one, row, T, "proto")).toBe(one);
  });
  test("两个表单各占一行、互不干扰", () => {
    const other: MultiRow = { type: "multiselect", id: "t9", placeholder: "用量", options: [{ label: "今日", value: "d" }, { label: "本周", value: "w" }] };
    let s = toggleFormValue("", design, T, "v3");
    s = toggleFormValue(s, other, "用量", "w");
    s = toggleFormValue(s, design, T, "proto");
    expect(s).toBe(`【${T}】✓ 按 v3 开工；✓ 先出原型\n【用量】✓ 本周\n`);
  });
  test("手改那一行：勾选以文字为准（删掉一项 = 取消那一项）", () => {
    const edited = `【${T}】✓ 夜里只在线上出问题时叫醒我`;
    expect(pickedFromText(`${edited}\n补充`, design, T)).toEqual(["night_wake"]);
    expect(pickedFromText("整行被删了", design, T)).toEqual([]);
  });
});

describe("composeFormSend（发送时原位换成 [select:…]）", () => {
  const titles = formTitles([design]);
  const form: OpenForm = { messageId: "m2", rowKey: "m:d_t8_design_form", row: design };
  test("同步行 + 补充文字", () => {
    const r = composeFormSend(`${LINE}\n周三前先给我看一眼稿子`, [form], titles);
    expect(r.wire).toBe("[select:d_t8_design_form:v3,night_wake]\n周三前先给我看一眼稿子");
    expect(r.answered).toEqual([{ messageId: "m2", rowKey: "m:d_t8_design_form", choiceValue: "d_t8_design_form:v3,night_wake" }]);
  });
  test("只有同步行：与点「提交」的回投完全一致", () => {
    expect(composeFormSend(`${LINE}\n`, [form], titles).wire).toBe("[select:d_t8_design_form:v3,night_wake]");
  });
  test("行尾补充换到下一行", () => {
    expect(composeFormSend(`${LINE} 周三前`, [form], titles).wire).toBe("[select:d_t8_design_form:v3,night_wake]\n周三前");
  });
  test("两个表单各转各的", () => {
    const other: MultiRow = { type: "multiselect", id: "t9", placeholder: "用量", options: [{ label: "今日", value: "d" }] };
    const forms = [{ messageId: "m3", rowKey: "m:t9", row: other }, form];
    const r = composeFormSend(`${LINE}\n【用量】✓ 今日\n两个都按这个来`, forms, formTitles([design, other]));
    expect(r.wire).toBe("[select:d_t8_design_form:v3,night_wake]\n[select:t9:d]\n两个都按这个来");
    expect(r.answered.map((a) => a.messageId)).toEqual(["m2", "m3"]);
  });
  test("同一 id 复用：对应列表里最新的那条（forms 新的在前）；同一表单只认第一行", () => {
    const older: OpenForm = { ...form, messageId: "m1" };
    const r = composeFormSend(`${LINE}\n${LINE}`, [form, older], titles);
    expect(r.answered.map((a) => a.messageId)).toEqual(["m2"]);
    expect(r.wire).toBe(`[select:d_t8_design_form:v3,night_wake]\n${LINE}`);
  });
  test("已作答 / 不在视图里的表单、空行：按普通文字发", () => {
    expect(composeFormSend(`${LINE}\n补充`, [], titles)).toEqual({ wire: `${LINE}\n补充`, answered: [] });
    expect(composeFormSend(`【${T}】随便写`, [form], titles).answered).toEqual([]);
  });
  test("少于 min 也照样转（owner 主动发的）", () => {
    const r = composeFormSend(`【${T}】✓ 先出原型`, [{ ...form, row: { ...design, min: 2 } }], titles);
    expect(r.wire).toBe("[select:d_t8_design_form:proto]");
  });
});

describe("wireToDisplay + 历史还原", () => {
  test("select 行还原成同步行，其余原样；查不到的 id 原样", () => {
    const resolve = (id: string) => (id === design.id ? { row: design, title: T } : null);
    expect(wireToDisplay("[select:d_t8_design_form:v3,night_wake]\n补充", resolve)).toBe(`${LINE}\n补充`);
    expect(wireToDisplay("[select:nope:x]\n补充", resolve)).toBeNull();
    expect(wireToDisplay("普通消息", resolve)).toBeNull();
  });

  const ts = (seq: number) => `2026-09-28T00:00:${String(seq).padStart(2, "0")}Z`;
  const u = (seq: number, text: string): NeutralMessage => ({ seq, role: "user", text, ts: ts(seq) });
  const a = (seq: number, extra: Partial<NeutralMessage>): NeutralMessage => ({ seq, role: "assistant", ts: ts(seq), ...extra });

  test("输入框发出的多行消息：气泡显示同步行，表单回填已答", () => {
    const out = toChatMessages([
      a(1, { replyText: "定一下", replyComponents: [design] }),
      u(2, "[select:d_t8_design_form:v3,night_wake]\n周三前给稿"),
    ]);
    expect(out[1].content).toBe(`${LINE}\n周三前给稿`);
    expect(out[0].replyClicks).toEqual({ "m:d_t8_design_form": "d_t8_design_form:v3,night_wake" });
  });
  test("答的是更早一条消息的表单：往前找含该 id 的消息，而不只看最近锚点", () => {
    const later = { type: "buttons" as const, buttons: [{ id: "ok", label: "好" }] };
    const out = toChatMessages([
      a(1, { replyText: "表单", replyComponents: [design] }),
      u(2, "继续"),
      a(3, { replyText: "另一个问题", replyComponents: [later] }),
      u(4, "[select:d_t8_design_form:proto]\n回头补答"),
    ]);
    expect(out[3].content).toBe(`【${T}】✓ 先出原型\n回头补答`);
    expect(out[0].replyClicks?.["m:d_t8_design_form"]).toBe("d_t8_design_form:proto");
    expect(out[2].replyClicks).toBeUndefined();
  });
  test("单行回投（点「提交」）同样按 id 找到更早的消息，沿用原有 label 还原", () => {
    const later = { type: "buttons" as const, buttons: [{ id: "ok", label: "好" }] };
    const out = toChatMessages([
      a(1, { replyText: "表单", replyComponents: [design] }),
      u(2, "继续"),
      a(3, { replyText: "另一个问题", replyComponents: [later] }),
      u(4, "[select:d_t8_design_form:v3]"),
    ]);
    expect(out[3].content).toBe("按 v3 开工");
    expect(out[0].replyClicks?.["m:d_t8_design_form"]).toBe("d_t8_design_form:v3");
  });
  test("同一 id 被两条消息复用：对应最新一条还没作答的", () => {
    const out = toChatMessages([
      a(1, { replyText: "第一次", replyComponents: [design] }),
      u(2, "[select:d_t8_design_form:v3]"),
      a(3, { replyText: "再问一次", replyComponents: [design] }),
      u(4, "[select:d_t8_design_form:proto]\n这次改主意"),
    ]);
    expect(out[0].replyClicks?.["m:d_t8_design_form"]).toBe("d_t8_design_form:v3");
    expect(out[2].replyClicks?.["m:d_t8_design_form"]).toBe("d_t8_design_form:proto");
  });
});
