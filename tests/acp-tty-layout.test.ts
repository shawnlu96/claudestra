import { describe, expect, test } from "bun:test";
import { createTtyLayout, hangWrap } from "../src/lib/acp/tty-layout.ts";
import { createTtyScreen } from "../src/lib/acp/tty-screen.ts";
import { renderFixtures } from "./helpers/acp-transcript-fixtures.ts";
import { termText } from "./helpers/acp-tty-term.ts";

// ACP 窗口 TTY 排法：窄屏（手机 52 列）去掉时间列、悬挂缩进；宽屏去色后与纯文本逐字一致；各类条目颜色不同
const plain = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");
const tty = (cols: number) => {
  const l = createTtyLayout();
  return renderFixtures((i, at) => l(i, cols, at));
};

describe("窄屏排版（52 列）", () => {
  const lines = plain(tty(52)).split("\n");

  test("不再有 ≥4 格行首空白；工具行顶格、结果行缩一格；时间只在段落起点单起一行", () => {
    expect(lines.filter((l) => /^ {4}/.test(l))).toEqual([]);
    expect(lines).toContain("● Bash(mktemp -d /private/tmp/lck1-audit.XXXXXX)");
    expect(lines).toContain(" ⎿ 无输出");
    expect(lines.filter((l) => /^\d\d:\d\d:\d\d$/.test(l))).toEqual(["11:23:20", "11:23:21", "11:25:28", "11:25:28"]);
    expect(lines.some((l) => l.includes("["))).toBe(true); // 「Sent message(s): [...]」里的方括号还在
    expect(lines.filter((l) => /^\[\d\d:/.test(l))).toEqual([]);
  });

  test("每行不超过 51 格；折下来的行悬挂缩进到正文开头，不回第 0 列", () => {
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(51);
    const i = lines.findIndex((l) => l.startsWith("● Bash(git diff 93410059"));
    expect(lines[i + 1]).toMatch(/^ {2}\S/);
    expect(hangWrap(` ⎿ ✗ ${"x".repeat(30)}`, 20)).toEqual([" ⎿ ✗ xxxxxxxxxxxxxx", "   xxxxxxxxxxxxxxxx"]);
    expect(hangWrap("● 一二三四五六七八九十", 12)).toEqual(["● 一二三四", "  五六七八", "  九十"]); // 留一格 = 11 格，汉字不拆半
    expect(hangWrap("短", 12)).toEqual(["短"]);
    // 按字素簇折：组合 emoji 不拆到两行；带变体选择符的 emoji 按整簇两格算，首行不超 8 格
    expect(hangWrap("● abc👩‍💻def", 9)).toEqual(["● abc👩‍💻d", "  ef"]); // 8 格：● 空格 abc 👩‍💻(2) d
    for (const l of hangWrap("● abc❤️def", 9)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(8);
  });
});

test("宽屏（≥100 列）去掉颜色后与纯文本窗口逐字一致", () => {
  expect(plain(tty(100))).toBe(renderFixtures());
  expect(plain(tty(80))).toBe(renderFixtures());
});

test("各类条目样式不同：收到的消息青、工具 ● 绿名字加粗、正文 ● 加粗、结果暗、失败红、分隔暗", () => {
  const l = createTtyLayout(), at = new Date(2026, 9, 7, 9, 0, 0);
  for (const cols of [52, 100]) {
    expect(l("> owner：看下", cols, at)).toContain("\x1b[1;36m> owner：\x1b[0m\x1b[36m看下\x1b[0m");
    expect(l("● Bash(ls)", cols, at)).toContain("\x1b[32m●\x1b[0m \x1b[1mBash\x1b[0m(ls)");
    expect(l("● 好的", cols, at)).toContain("\x1b[1m●\x1b[0m 好的");
    expect(l("  ⎿ 3 行输出", cols, at)).toContain("\x1b[2m");
    expect(l("  ⎿ ✗ 失败了", cols, at)).toContain("\x1b[31m");
    expect(l("⛔ 额度用完：x", cols, at)).toBe(`${cols < 80 ? "" : "           "}\x1b[31m⛔ 额度用完：x\x1b[0m`);
    expect(l("── 回合结束 ──", cols, at)).toContain("\x1b[2m── 回合结束 ──\x1b[0m");
    expect(l("── 回合失败 ──", cols, at)).toContain("\x1b[31m");
  }
});

test("窗口变窄后下一段就换排法；状态行暗色、终端还原的屏幕只剩纯文本", () => {
  const st = { cols: 100, out: "" };
  const s = createTtyScreen({ write: (x) => void (st.out += x), columns: () => st.cols }, () => ({ busy: false, queued: 0, permissions: 0 }), () => 0);
  const at = new Date(2026, 9, 7, 9, 0, 0);
  s.show("● Bash(ls)", at);
  st.cols = 52;
  s.resize();
  s.show("● Bash(pwd)\n  ⎿ x", at);
  expect(st.out).toContain("\x1b[2m· 空闲\x1b[0m");
  expect(termText(st.out)).toBe("[09:00:00] ● Bash(ls)\n● Bash(pwd)\n ⎿ x\n· 空闲");
});
