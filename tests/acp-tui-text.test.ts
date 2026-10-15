import { describe, expect, test } from "bun:test";
import { fitLine, renderPara, span, stripSgr } from "../src/lib/acp/tui/text.ts";

// ACP 终端视图的排字底座：按显示宽度折行（中日韩两格、组合 emoji 不拆），每行 ≤ cols - 1，颜色每段自带复位

const w = (s: string) => Bun.stringWidth(stripSgr(s));

describe("renderPara 折行", () => {
  test("英文断在空格处，悬挂缩进到 lead 后面", () => {
    const rows = renderPara({ lead: [span("• ")], body: [span("alpha beta gamma delta epsilon")] }, 14);
    expect(rows.map(stripSgr)).toEqual(["• alpha beta", "  gamma delta", "  epsilon"]);
    expect(rows.every((r) => w(r) <= 13)).toBe(true);
  });

  test("中文按两格算、没空格就硬切；emoji 组合簇不拆", () => {
    const rows = renderPara({ body: [span("等等等等等等👩‍💻等")] }, 8);
    expect(rows.map(stripSgr)).toEqual(["等等等", "等等等", "👩‍💻等"]);
    expect(rows.every((r) => w(r) <= 7)).toBe(true);
  });

  test("空格后面跟着一长段中文：就地断，不把整段挤到下一行（上一行只剩前缀）", () => {
    const rows = renderPara({ body: [span(`✻ ${"思考".repeat(20)}`)] }, 21).map(stripSgr);
    expect(rows[0]).toBe("✻ 思考思考思考思考思");
    expect(renderPara({ body: [span("hello world again")] }, 13).map(stripSgr)).toEqual(["hello world", "again"]); // 英文照旧不拆词
  });

  test("硬切时闭合标点不单独落到行首（审批提示末尾的「）」），和前一个字一起折下去", () => {
    const rows = renderPara({ body: [span("审批 [1]允许 [2]总是允许 [3]拒绝（y/n/序号 + 回车）")] }, 50).map(stripSgr);
    expect(rows.at(-1)).toBe("车）");
    expect(renderPara({ body: [span("一二三。")] }, 7).map(stripSgr)).toEqual(["一二", "三。"]);
  });

  test("cont 给了就用它（引用竖线每折都有），颜色每段自带复位", () => {
    const rows = renderPara({ lead: [span("│ ", "2")], cont: [span("│ ", "2")], body: [span("aaaa bbbb", "3")] }, 8);
    expect(rows.map(stripSgr)).toEqual(["│ aaaa", "│ bbbb"]);
    expect(rows[0]).toBe("\x1b[2m│ \x1b[0m\x1b[3maaaa\x1b[0m");
  });

  test("极窄窗口：一个宽字比整行还宽也至少放一个，不死循环", () => {
    expect(renderPara({ body: [span("等等")] }, 2).map(stripSgr)).toEqual(["等", "等"]);
  });
});

test("fitLine 只要一行：放不下就截，留一格不碰行尾", () => {
  expect(stripSgr(fitLine([span("✻ 思考中… 12s")], 10))).toBe("✻ 思考中…");
  expect(fitLine([span("abc", "1")], 80)).toBe("\x1b[1mabc\x1b[0m");
});
