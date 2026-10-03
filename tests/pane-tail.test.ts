/**
 * 尾部空行：capture-pane 原样输出可见区的尾部空行（TUI 画在屏幕顶部、窗口 resize 后没重绘底部），「看最后 N 行」的判定得先剪掉它们。
 * 这里是 lib/pane-tail.ts 本身，以及改成先剪空行的各个检测（dev-channels / parseModalOptions / isAutoConfirmableModal 的用例在
 * tests/modal-parser.test.ts、tests/modal-confirm.test.ts）。每个检测：画面在顶部 + 尾部空行 = 跟没有空行时同一个结论。
 */
import { describe, expect, test } from "bun:test";
import { paneTail, trimTrailingBlank } from "../src/lib/pane-tail.js";
import { detectArrowNavModal, detectPermissionMode, detectSessionIdlePrompt, paneCompactProgress } from "../src/lib/tmux-helper.js";
import { paneLooksWorking } from "../src/lib/turn-state.js";
import { parseAuqPane } from "../src/lib/auq-pane.js";

/** tmux 的输出：每行（含空行）以换行结尾 */
const blankTail = (lines: string[], n = 35) => [...lines, ...Array(n).fill("")].map((l) => `${l}\n`).join("");
const both = (lines: string[], f: (pane: string) => unknown) => [f(lines.join("\n")), f(blankTail(lines))];

describe("trimTrailingBlank / paneTail", () => {
  test("只剪尾部整行空白（含只有空格的行），中间的空行和最后一行的行尾空格保留", () => {
    expect(trimTrailingBlank(["a", "", "b  ", "   ", "", "\t"])).toEqual(["a", "", "b  "]);
    expect(trimTrailingBlank(["", "  "])).toEqual([]);
    expect(trimTrailingBlank([])).toEqual([]);
  });
  test("paneTail 从最后一行有字处往上数", () => {
    expect(paneTail(blankTail(["1", "2", "3", "4"]), 2)).toEqual(["3", "4"]);
    expect(paneTail("x\ny", 5)).toEqual(["x", "y"]);
    expect(paneTail("\n\n\n", 3)).toEqual([]);
  });
});

describe("detectPermissionMode（临时放行要先认出当前模式）", () => {
  const mk = (banner: string) => ["─── agent ──", "❯ ▎", "─────────────", `  ${banner} · ← for agents`];
  test("页脚 banner 后面跟着尾部空行 → 照样认出", () => {
    expect(both(mk("⏵⏵ auto mode on (shift+tab to cycle)"), detectPermissionMode)).toEqual(["auto", "auto"]);
    expect(both(mk("⏵⏵ bypass permissions on (shift+tab to cycle)"), detectPermissionMode)).toEqual(["bypassPermissions", "bypassPermissions"]);
    expect(both(["some output", "❯ ▎"], detectPermissionMode)).toEqual(["default", "default"]);
  });
  test("纯 shell + 尾部空行 → 仍是 null", () => {
    expect(both(["shawn@mac ~/repos %"], detectPermissionMode)).toEqual([null, null]);
  });
});

describe("detectSessionIdlePrompt（isAutoConfirmableModal 的黑名单：看不见它就会被当普通框按 Enter = 从摘要恢复）", () => {
  const idle = ["This session is 5h 6m old and 485.2k tokens.", "", "❯ 1. Resume from summary (recommended)", "  2. Resume full session as-is", "",
    "Enter to confirm · Esc to cancel"];
  test("弹窗画在顶部 + 35 行尾部空行 → 认出", () => {
    const [plain, tall] = both(idle, detectSessionIdlePrompt);
    expect(plain).toContain("5h 6m old");
    expect(tall).toBe(plain);
  });
  test("屏上是引用的弹窗文字、底下是正常运行的状态栏 + 尾部空行 → 仍是 null", () => {
    const quoted = ["    ❯ 1. Resume from summary", "      2. Resume full session`;", "─── claudestra ──", "❯ ▎", "─────────────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"];
    expect(both(quoted, detectSessionIdlePrompt)).toEqual([null, null]);
  });
});

describe("detectArrowNavModal（/effort 这类滑块，手机端出方向键按钮）", () => {
  test("滑块 + 尾部空行 → 照样认出", () => {
    expect(both(["   low   medium   high   xhigh   max", "                              ▲", "←/→ to change effort · Enter to confirm"], detectArrowNavModal))
      .toEqual(["horizontal", "horizontal"]);
  });
  test("没有 Enter 提示 + 尾部空行 → 仍是 null", () => {
    expect(both(["just a slider", "←/→ to change"], detectArrowNavModal)).toEqual([null, null]);
  });
});

describe("paneCompactProgress（压缩进度条）", () => {
  test("进度条 + 尾部空行 → 照样读出百分比", () => {
    expect(both(["✢ Compacting conversation…", "  ▰▰▱▱▱▱▱▱▱▱ 37%", "❯ "], paneCompactProgress)).toEqual([37, 37]);
  });
  test("没有进度条 + 尾部空行 → 仍是 null", () => {
    expect(both(["✶ Thinking… (2m 7s)", "❯ "], paneCompactProgress)).toEqual([null, null]);
  });
});

describe("paneLooksWorking（侧栏黄点；api-routes 的兜底先取 paneTail(pane, 10) 再判）", () => {
  const bg = ["✻ Waiting for 1 background agent to finish", "─────", "❯ ", "─────", "  Opus 4.8 · ctx 59% · 5h 77% · 7d 17%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) ·", "  ⏺ main", "  ◯ general-purpose  Anal… 1m 13s · ↓ 58.1k tokens"];
  const idle = ["✻ Worked for 46s · done 9:51 PM", "─────", "❯ ", "─────", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];
  test("后台 agent 在跑 + 尾部空行 → 照样判工作中", () => {
    expect(both(bg, paneLooksWorking)).toEqual([true, true]);
    expect(paneLooksWorking(paneTail(blankTail(bg), 10).join("\n"))).toBe(true);
  });
  test("真空闲 + 尾部空行 → 仍不算工作中", () => {
    expect(both(idle, paneLooksWorking)).toEqual([false, false]);
    expect(paneLooksWorking(paneTail(blankTail(idle), 10).join("\n"))).toBe(false);
  });
});

describe("parseAuqPane：Codex 选择框（页脚从底部最多数 45 行）", () => {
  const prompt = ["  Approaching rate limits", "  Switch to gpt-5.6-luna for lower credit usage?", "", "› 1. Switch to gpt-5.6-luna", "  2. Keep current model", "",
    "  Press enter to confirm or esc to go back"];
  test("框画在顶部 + 50 行尾部空行（高窗口）→ 照样认出", () => {
    expect(parseAuqPane(blankTail(prompt, 50))?.options.map((o) => o.label)).toEqual(["Switch to gpt-5.6-luna", "Keep current model"]);
  });
  test("页脚只在 45 行有字的内容之外（旧输出）+ 尾部空行 → 仍不认", () => {
    expect(parseAuqPane(blankTail([...prompt, ...Array.from({ length: 45 }, (_, i) => `line ${i}`)], 50))).toBeNull();
  });
});
