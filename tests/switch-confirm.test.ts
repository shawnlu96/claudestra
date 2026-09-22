/**
 * 切模型 / 切 effort 二次确认框（P9）。
 *
 * 夹具是 CC 2.1.280 真机原屏（tmux capture-pane -p -J -S -60）：会话有 prompt cache 时
 * `/model` 弹「Switch model?」、`/effort` 也弹「Change effort level?」——后者以前没人认，
 * 只切 effort 时框就一直挂着。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import {
  detectSwitchConfirmPrompt,
  switchPromptMatches,
  countSettledSwitchCommands,
  modelFamilies,
  paneLooksIdle,
} from "../src/lib/tmux-helper.ts";

const fx = (name: string) =>
  readFileSync(new URL(`./fixtures/switch-confirm/cc2.1.280-${name}.txt`, import.meta.url), "utf8");

const SWITCH_MODEL = fx("switch-model");
const CHANGE_EFFORT = fx("change-effort");
const MODEL_SET = fx("model-set");
const MODEL_THEN_EFFORT = fx("model-then-effort-set");
const EFFORT_SWALLOWED = fx("effort-swallowed-by-model-dialog");

describe("detectSwitchConfirmPrompt", () => {
  test("Switch model?（cache 警告）→ 选 Yes = Enter", () => {
    expect(detectSwitchConfirmPrompt(SWITCH_MODEL)).toEqual({
      kind: "model",
      target: "Sonnet 5",
      cached: true,
      keys: ["Enter"],
    });
  });

  test("Change effort level?（cache 警告）→ 选 Yes = Enter", () => {
    expect(detectSwitchConfirmPrompt(CHANGE_EFFORT)).toEqual({
      kind: "effort",
      target: "high",
      cached: true,
      keys: ["Enter"],
    });
  });

  test("框已关（命令落地后的屏）→ null", () => {
    expect(detectSwitchConfirmPrompt(MODEL_SET)).toBeNull();
    expect(detectSwitchConfirmPrompt(MODEL_THEN_EFFORT)).toBeNull();
    expect(detectSwitchConfirmPrompt(EFFORT_SWALLOWED)).toBeNull();
  });

  test("光标被挪到 No → 先 Up 再 Enter", () => {
    const moved = SWITCH_MODEL
      .replace("❯ 1. Yes, switch to Sonnet 5", "  1. Yes, switch to Sonnet 5")
      .replace("  2. No, go back", "❯ 2. No, go back");
    expect(detectSwitchConfirmPrompt(moved)?.keys).toEqual(["Up", "Enter"]);
  });

  test("框的文字只是显示在对话里（下面还有输入框页脚）→ null", () => {
    const quoted =
      SWITCH_MODEL.trimEnd() +
      "\n" +
      "─".repeat(80) +
      "\n❯ \n" +
      "─".repeat(80) +
      "\n  Haiku 4.5\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n";
    expect(detectSwitchConfirmPrompt(quoted)).toBeNull();
  });

  test("标题对但选项不是 Yes/No（比如 /model 选择器）→ null", () => {
    const picker = [
      "   Switch model?",
      "",
      "   ❯ 1. Opus 5.5",
      "     2. Sonnet 5",
      "     3. Haiku 4.5",
      "",
    ].join("\n");
    expect(detectSwitchConfirmPrompt(picker)).toBeNull();
  });

  test("别的编号确认框（权限 / 会话闲置）不误认", () => {
    const perm = [
      " Bash command",
      "   rm foo",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No, and tell Claude what to do differently (esc)",
      "",
    ].join("\n");
    expect(detectSwitchConfirmPrompt(perm)).toBeNull();
    const idle = [
      " This session is 21h 6m old and 913.2k tokens.",
      " ❯ 1. Resume from summary (recommended)",
      "   2. Resume full session as-is",
      "",
    ].join("\n");
    expect(detectSwitchConfirmPrompt(idle)).toBeNull();
  });

  test("残留确认框会让 paneLooksIdle 为假（claude-settings 的 409 前要先认它）", () => {
    expect(paneLooksIdle(SWITCH_MODEL)).toBe(false);
    expect(paneLooksIdle(CHANGE_EFFORT)).toBe(false);
    expect(paneLooksIdle(MODEL_SET)).toBe(true);
  });
});

describe("switchPromptMatches", () => {
  const model = detectSwitchConfirmPrompt(SWITCH_MODEL)!;
  const effort = detectSwitchConfirmPrompt(CHANGE_EFFORT)!;

  test("model 按家族比：id 对显示名", () => {
    expect(switchPromptMatches(model, "model", "claude-sonnet-5")).toBe(true);
    expect(switchPromptMatches(model, "model", "claude-opus-5-5")).toBe(false);
  });

  test("解析不出家族的自定义 id 只认种类", () => {
    expect(switchPromptMatches(model, "model", "my-proxy-model")).toBe(true);
  });

  test("effort 按档位全等（忽略大小写/空白）", () => {
    expect(switchPromptMatches(effort, "effort", "high")).toBe(true);
    expect(switchPromptMatches(effort, "effort", " HIGH ")).toBe(true);
    expect(switchPromptMatches(effort, "effort", "medium")).toBe(false);
  });

  test("种类不符不按：切 model 时撞上 effort 框", () => {
    expect(switchPromptMatches(effort, "model", "claude-sonnet-5")).toBe(false);
    expect(switchPromptMatches(model, "effort", "high")).toBe(false);
  });
});

describe("countSettledSwitchCommands", () => {
  test("框挂着时本次命令还没回显，不算落地", () => {
    expect(countSettledSwitchCommands(SWITCH_MODEL, "model")).toBe(0);
  });

  test("回显 + ⎿ 结果行才算一条", () => {
    expect(countSettledSwitchCommands(MODEL_SET, "model")).toBe(1);
    expect(countSettledSwitchCommands(MODEL_SET, "effort")).toBe(0);
  });

  test("scrollback 里上一次的 Set model to 不会让下一次提前放行", () => {
    // 旧轮询全屏搜 /Set model to/：注入新 /model、框还没画出来的那一拍就命中收工
    const base = countSettledSwitchCommands(MODEL_SET, "model");
    // 输入框那行是「❯ + NBSP」
    const typedNotRendered = MODEL_SET.replace(/^❯\s*$/m, "❯ /model claude-haiku-4-5-20251001");
    expect(typedNotRendered).toContain("❯ /model claude-haiku-4-5-20251001");
    expect(/Set model to/i.test(typedNotRendered)).toBe(true);
    expect(countSettledSwitchCommands(typedNotRendered, "model")).toBe(base);
  });

  test("输入框里还没提交的 /effort 不算", () => {
    const typed = MODEL_SET.replace(/^❯\s*$/m, "❯ /effort high");
    expect(typed).toContain("❯ /effort high");
    expect(countSettledSwitchCommands(typed, "effort")).toBe(0);
  });

  test("先切模型再切 effort：两条都落地（此时 effort 不再弹框）", () => {
    // 夹具里之前已有一次 /model + 一次 /effort
    expect(countSettledSwitchCommands(MODEL_THEN_EFFORT, "model")).toBe(2);
    expect(countSettledSwitchCommands(MODEL_THEN_EFFORT, "effort")).toBe(2);
  });

  test("框挂着时紧跟着打的 /effort 被框吞掉：只多了 model、effort 没落地", () => {
    // 屏上 /effort low 的回显根本不存在——这就是必须等 /model 落地再注入的原因
    expect(countSettledSwitchCommands(EFFORT_SWALLOWED, "model")).toBe(3);
    expect(countSettledSwitchCommands(EFFORT_SWALLOWED, "effort")).toBe(2);
    expect(EFFORT_SWALLOWED).not.toContain("/effort low");
  });
});

describe("modelFamilies", () => {
  test("显示名与 id 都能抽出家族", () => {
    expect([...modelFamilies("Sonnet 5")]).toEqual(["sonnet"]);
    expect([...modelFamilies("claude-haiku-4-5-20251001")]).toEqual(["haiku"]);
    expect(modelFamilies("gpt-5").size).toBe(0);
  });
});
