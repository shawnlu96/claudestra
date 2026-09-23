import { describe, expect, test } from "bun:test";
import { isClaudeReady, paneLooksIdle } from "../src/lib/tmux-helper";

// 52 列窄窗口(手机开过网页终端后窗口就停在这个宽度)的真实页脚:状态栏 / 模式 banner /
// 右侧通知各占一行,`❯` 恰好在倒数第 5 行。再多一条通知(截图后的 Image in clipboard)就出界。
const SEP = "─".repeat(52);
const box = (footer: string[], above = ["⏺ 改完了。", ""]) =>
  [
    ...above,
    `${"─".repeat(33)} claudestra-debug ─`,
    "❯ ",
    SEP,
    "  Ctx 81% · 5h 1% 7d 30% · claudestra-debug",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) ·",
    ...footer,
    "",
    "",
  ].join("\n");

const ONE_NOTICE = ["          ✘ Auto-update failed · Run claude doctor"];
const TWO_NOTICES = [...ONE_NOTICE, "          Image in clipboard · ctrl+v to paste"];

describe("页脚折行:`❯` 按输入框结构找,不数最后 5 行", () => {
  test("一条通知(❯ 在倒数第 5 行)→ 空闲", () => {
    expect(paneLooksIdle(box(ONE_NOTICE))).toBe(true);
  });

  test("两条通知(❯ 被挤到倒数第 6 行)→ 仍空闲", () => {
    expect(paneLooksIdle(box(TWO_NOTICES))).toBe(true);
    expect(isClaudeReady(box(TWO_NOTICES))).toBe(true);
  });

  test("输入框里有字 + 高页脚 → 仍空闲(宽松模式)", () => {
    expect(paneLooksIdle(box(TWO_NOTICES).replace("❯ \n", "❯ 帮我看下\n"))).toBe(true);
  });

  test("高页脚 + spinner 在输入框上方 → 忙", () => {
    const busy = box(TWO_NOTICES, ["✶ Processing… (2m 12s · ↓ 7.8k tokens)", ""]);
    expect(paneLooksIdle(busy)).toBe(false);
  });

  test("transcript 里的旧输入(❯ /clear,上一行不是边框)不算输入框", () => {
    const pane = ["❯ /clear", "", "❯ /model", "  ⎿  Set model", "x", "y", "z"].join("\n");
    expect(paneLooksIdle(pane)).toBe(false);
  });
});
