/**
 * 行内按钮微语法 `[[{#id .style}label]]` 的解析/剥离单测(v2.20+)。
 * 语法要点:{…} capture 紧跟**开分隔符**(do-md 0.11.2 InlineRule 同源,
 * 不是 Pandoc 的尾置)。Discord 出站拆分与 web 历史还原共用这一套。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import {
  parseInlineButtons,
  splitInlineButtons,
  plainLabel,
  toButtonRows,
} from "../src/lib/inline-buttons.js";

describe("parseInlineButtons", () => {
  test("基本形态:id + style + label", () => {
    const b = parseInlineButtons("确认后我就发:[[{#release_go .success}确认发布]]");
    expect(b).toEqual([{ id: "release_go", style: "success", label: "确认发布" }]);
  });
  test("多个按钮按文档序", () => {
    const b = parseInlineButtons("[[{#a .primary}甲]] 或 [[{#b .danger}乙]]\n再看 [[{#c}丙]]");
    expect(b.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(b[2].style).toBe("secondary"); // 缺省
  });
  test("style 白名单外 → secondary;首个 .word 生效(do-md variant 语义)", () => {
    expect(parseInlineButtons("[[{#x .rainbow}好]]")[0].style).toBe("secondary");
    expect(parseInlineButtons("[[{#x .danger .primary}好]]")[0].style).toBe("danger");
  });
  test("#id 后者胜(do-md later-wins);坏 id / 无 id 不产出按钮", () => {
    expect(parseInlineButtons("[[{#old #new}好]]")[0].id).toBe("new");
    expect(parseInlineButtons("[[{.primary}没id]]")).toEqual([]);
    expect(parseInlineButtons("[[{#bad!id}好]]")).toEqual([]); // id 含 ! → 白名单不过
  });
  test("fenced code 里的语法是字面量", () => {
    const md = "示例:\n```\n[[{#go}确认]]\n```\n真按钮 [[{#real}点我]]";
    expect(parseInlineButtons(md).map((b) => b.id)).toEqual(["real"]);
  });
  test("inline code span 里的语法是字面量", () => {
    const md = "语法是 `[[{#demo}文字]]`,试试 [[{#live}真的]]";
    expect(parseInlineButtons(md).map((b) => b.id)).toEqual(["live"]);
  });
  test("普通 [[wiki]](无 capture)不匹配", () => {
    expect(parseInlineButtons("提到 [[某条记忆]] 而已")).toEqual([]);
  });
});

describe("splitInlineButtons", () => {
  test("剥离后正文干净,整行只有按钮 → 行删掉", () => {
    const r = splitInlineButtons("发布前确认:\n\n[[{#go .success}确认]] [[{#no}取消]]");
    expect(r.text).toBe("发布前确认:");
    expect(r.buttons.map((b) => b.id)).toEqual(["go", "no"]);
  });
  test("行内混排:只剥按钮,句子保留", () => {
    const r = splitInlineButtons("点 [[{#go}确认]] 后我就开工,或者 [[{#no}算了]]。");
    expect(r.buttons.length).toBe(2);
    expect(r.text).toBe("点  后我就开工,或者 。");
  });
  test("max 容量之外的保留字面量(不静默消失)", () => {
    const r = splitInlineButtons("[[{#a}1]] [[{#b}2]] [[{#c}3]]", 2);
    expect(r.buttons.map((b) => b.id)).toEqual(["a", "b"]);
    expect(r.text).toContain("[[{#c}3]]");
  });
  test("无按钮时原文原样返回", () => {
    const md = "没有任何按钮 [[wiki]] `[[{#x}code]]`";
    expect(splitInlineButtons(md)).toEqual({ text: md, buttons: [] });
  });
  test("剥离造成的连续空行收敛", () => {
    const r = splitInlineButtons("上文\n\n[[{#a}按钮]]\n\n下文");
    expect(r.text).toBe("上文\n\n下文");
  });
});

describe("plainLabel / toButtonRows", () => {
  test("去 markdown 标记,下划线保留", () => {
    expect(plainLabel("**确认**发布 `now`")).toBe("确认发布 now");
    expect(plainLabel("file_name 保留")).toBe("file_name 保留");
  });
  test("每行 ≤5 钮分行;label 超 80 截断", () => {
    const rows = toButtonRows(
      Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: "钮".repeat(100), style: "primary" }))
    );
    expect(rows.length).toBe(2);
    expect(rows[0].buttons.length).toBe(5);
    expect(rows[1].buttons.length).toBe(2);
    expect(rows[0].buttons[0].label.length).toBe(80);
  });
});

describe("双份一致性", () => {
  test("src/lib 与 web/lib/chat 逐字节一致", () => {
    const a = readFileSync(new URL("../src/lib/inline-buttons.ts", import.meta.url), "utf8");
    const b = readFileSync(new URL("../web/lib/chat/inline-buttons.ts", import.meta.url), "utf8");
    expect(a).toBe(b);
  });
});

describe("inlineButtonsToText", () => {
  test("按钮 → [label] 文本;其余原样", async () => {
    const { inlineButtonsToText } = await import("../src/lib/inline-buttons.js");
    expect(inlineButtonsToText("点 [[{#go .success}**确认**]] 开工")).toBe("点 [确认] 开工");
    expect(inlineButtonsToText("`[[{#x}code]]` 原样")).toBe("`[[{#x}code]]` 原样");
  });
});
