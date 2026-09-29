/**
 * Codex 运行中弹框 →「待你处理」的检测（lib/runtime-dialogs.ts）：内置的额度规则、扩展文件，以及收紧的范围——
 * 只认 Codex 窗口、只看末尾 15 个非空行、命中行得是「■ 」报错行或末尾是对话框形状。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCodexRuntimeDialog, parseDialogRules } from "../src/lib/runtime-dialogs.js";

const dir = mkdtempSync(join(tmpdir(), "rt-dialogs-"));
const NO_FILE = join(dir, "none.json");

/** 本机 rollout 原文（2026-09-27 task_complete.error.message，codex_error_info usage_limit_exceeded） */
const USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:41 AM.";
/** TUI 把它画成「■ 原文」，后面是空的输入框（形状同 tests/auq-pane.test.ts 的 2026-09-28 原屏） */
const CODEX_PANE = ["• 我先跑一遍测试。", "", `■ ${USAGE_LIMIT}`, "", "", "› Improve documentation in @filename", "", "  gpt-5.6 high · 100% left · ~/repo"].join("\n");

describe("内置规则：Codex 额度用完", () => {
  test("rollout 原文画在 Codex 窗口末尾 → 建一条，context 是原文", () => {
    expect(detectCodexRuntimeDialog(CODEX_PANE, "codex", NO_FILE)).toEqual({ title: "Codex 额度用完了", context: USAGE_LIMIT });
  });

  test("不是 Codex 窗口（Claude / Pi / 查不到 runtime）→ 一律不认", () => {
    for (const rt of ["claude-code", "pi", undefined]) expect(detectCodexRuntimeDialog(CODEX_PANE, rt, NO_FILE)).toBeNull();
  });

  test("只是正文里提到这句话（不是「■ 」报错行，末尾也不是对话框）→ 不认", () => {
    const quoted = ["• 上次报的是 “You've hit your usage limit”，我查了一下原因。", "", "› ", "  gpt-5.6 high"].join("\n");
    expect(detectCodexRuntimeDialog(quoted, "codex", NO_FILE)).toBeNull();
  });

  test("报错行已经滚出末尾 15 行（之后又跑了一整轮）→ 不认，开着的那条会被结案", () => {
    const later = Array.from({ length: 20 }, (_, i) => `• 输出第 ${i} 行`);
    expect(detectCodexRuntimeDialog([`■ ${USAGE_LIMIT}`, ...later].join("\n"), "codex", NO_FILE)).toBeNull();
  });
});

describe("扩展规则：状态目录的 codex-dialogs.json", () => {
  test("合格的行生效，坏行（不是对象 / 正则编不过 / 没标题）跳过；文件改了下次就生效", () => {
    expect(parseDialogRules([{ pattern: "x", title: "好" }, { pattern: "(", title: "坏正则" }, { pattern: "x" }, "nope"]).map((r) => r.title)).toEqual(["好"]);
    const file = join(dir, "codex-dialogs.json");
    const pane = ["  Model is overloaded, retry?", "", "› 1. Retry", "  2. Cancel", "", "  Press enter to confirm or esc to go back"].join("\n");
    expect(detectCodexRuntimeDialog(pane, "codex", file)).toBeNull();
    writeFileSync(file, JSON.stringify([{ pattern: "model is overloaded", title: "模型过载" }]));
    expect(detectCodexRuntimeDialog(pane, "codex", file)).toEqual({ title: "模型过载", context: "Model is overloaded" });
  });

  test("扩展规则也受同样的收紧：末尾不是对话框形状、又不是报错行 → 不认", () => {
    const file = join(dir, "codex-dialogs-2.json");
    writeFileSync(file, JSON.stringify([{ pattern: "model is overloaded", title: "模型过载" }]));
    expect(detectCodexRuntimeDialog("• 日志里写着 model is overloaded\n› ", "codex", file)).toBeNull();
    expect(detectCodexRuntimeDialog("■ Model is overloaded\n› ", "codex", file)?.title).toBe("模型过载");
  });
});
