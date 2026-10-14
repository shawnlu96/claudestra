import { describe, expect, test } from "bun:test";
import { createMarkdown, inline, renderTable } from "../src/lib/acp/tui/markdown.ts";
import { stripSgr } from "../src/lib/acp/tui/text.ts";

// 助手正文 Markdown → 终端行：逐行喂（流式一行一行到），表格等整张到齐才排

function render(text: string, cols = 60): string[] {
  const md = createMarkdown();
  return [...text.split("\n").flatMap((l) => md.feed(l, cols)), ...md.end(cols)].map(stripSgr);
}

describe("块级元素", () => {
  test("标题去掉井号、列表换圆点（嵌套换空心）、有序列表保留序号、引用加竖线、分隔线", () => {
    expect(render("# 大标题\n## 小标题\n- 一\n  - 二\n3. 三\n> 引用\n---", 20)).toEqual([
      "大标题", "小标题", "• 一", "  ◦ 二", "3. 三", "│ 引用", "───────────────────",
    ]);
  });

  test("代码块上下有框、每行左竖线，里面的 Markdown 不解释；没合上的框在结束时补上", () => {
    expect(render("```ts\nconst a = **b**;\n```\n后文")).toEqual(["╭─ ts", "│ const a = **b**;", "╰─", "后文"]);
    expect(render("```\nx")).toEqual(["╭─", "│ x", "╰─"]);
  });

  test("代码块长行按宽度折，续行也带竖线", () => {
    expect(render("```\nabcdefghij\n```", 8)).toEqual(["╭─", "│ abcde", "│ fghij", "╰─"]);
  });
});

describe("行内元素", () => {
  test("粗体、斜体、行内代码、链接各有样式；代码里的星号不当粗体", () => {
    const spans = inline("a **粗** *斜* `x*y*` [文档](https://e.x/d)");
    expect(spans.map((s) => [s.t, s.s ?? ""])).toEqual([
      ["a ", ""], ["粗", "1"], [" ", ""], ["斜", "3"], [" ", ""], ["x*y*", "36"], [" ", ""], ["文档", "4;34"], [" (https://e.x/d)", "2"],
    ]);
  });

  test("不成对的星号、下划线照原样（snake_case、乘号）", () => {
    expect(inline("snake_case_name 2 * 3").map((s) => s.t).join("")).toBe("snake_case_name 2 * 3");
    expect(inline("snake_case_name 2 * 3").every((s) => !s.s)).toBe(true);
  });
});

describe("表格", () => {
  const T = ["| 文件 | 风险 |", "|---|---|", "| a.ts | 低 |", "| 中文名.ts | 中 |"];

  test("放得下：按显示宽度对齐（中文两格），表头下一道线", () => {
    expect(renderTable(T, 60).map(stripSgr)).toEqual(["文件      │ 风险", "──────────┼─────", "a.ts      │ 低", "中文名.ts │ 中"]);
  });

  test("放不下：改成逐行竖排「表头：值」，不横向溢出", () => {
    const rows = renderTable(T, 12).map(stripSgr);
    expect(rows).toEqual(["• a.ts", "  风险：低", "• 中文名.ts", "  风险：中"]);
    expect(rows.every((r) => Bun.stringWidth(r) <= 11)).toBe(true);
  });

  test("流式：表格行先压着（pending 给底栏预览），遇到非表格行一次出齐", () => {
    const md = createMarkdown();
    expect(T.flatMap((l) => md.feed(l, 60))).toEqual([]);
    expect(md.pending(60).map(stripSgr)[0]).toBe("文件      │ 风险");
    expect(md.feed("后文", 60).map(stripSgr)).toEqual(["文件      │ 风险", "──────────┼─────", "a.ts      │ 低", "中文名.ts │ 中", "后文"]);
    expect(md.pending(60)).toEqual([]);
  });
});
