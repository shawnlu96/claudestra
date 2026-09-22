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
  switchResultToast,
  switchRejectionToast,
  lastSettledSwitch,
  effortDialogLevel,
  runSwitchCommand,
  modelFamilies,
  paneLooksIdle,
  type SwitchIO,
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

  test("ultracode 在框里写作 xhigh：/effort ultracode 引出的框要认", () => {
    const xhigh = detectSwitchConfirmPrompt(
      CHANGE_EFFORT.replace("Yes, switch to high", "Yes, switch to xhigh").replace("Switching to high", "Switching to xhigh"),
    )!;
    expect(xhigh.target).toBe("xhigh");
    expect(switchPromptMatches(xhigh, "effort", "ultracode")).toBe(true);
    expect(switchPromptMatches(xhigh, "effort", "xhigh")).toBe(true);
    expect(switchPromptMatches(effort, "effort", "ultracode")).toBe(false);
    expect(effortDialogLevel(" UltraCode ")).toBe("xhigh");
    expect(effortDialogLevel("High")).toBe("high");
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

describe("switchResultToast", () => {
  // 2.1.280 e2e 实测：代按 effort 框后有时只在输入框上方出右对齐 toast、不进对话记录
  const TOAST =
    " ".repeat(62) +
    "Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation";
  const withToast = MODEL_SET.replace(/^(─{20,})$/m, `${TOAST}\n$1`);

  test("认出输入框上方的 toast", () => {
    expect(withToast).toContain(TOAST);
    expect(switchResultToast(withToast, "effort")).toBe(TOAST.trim());
    expect(switchResultToast(withToast, "model")).toBeNull();
  });

  test("对话里的 ⎿ 结果行不是 toast（它由 countSettledSwitchCommands 管）", () => {
    expect(switchResultToast(MODEL_SET, "model")).toBeNull();
    expect(switchResultToast(MODEL_THEN_EFFORT, "effort")).toBeNull();
  });
});

describe("modelFamilies", () => {
  test("显示名与 id 都能抽出家族", () => {
    expect([...modelFamilies("Sonnet 5")]).toEqual(["sonnet"]);
    expect([...modelFamilies("claude-haiku-4-5-20251001")]).toEqual(["haiku"]);
    expect(modelFamilies("gpt-5").size).toBe(0);
  });
});

// ── 全屏（alt-screen）模拟：capture 只拿得到可见屏，满屏后旧行从顶上滚走 ──
const RULE = "─".repeat(80);
function screen(conv: string[], opts: { rows?: number; toast?: string } = {}): string {
  const rows = opts.rows ?? 20;
  const body = conv.slice(-rows);
  while (body.length < rows) body.push("");
  return [
    ...body,
    opts.toast ? " ".repeat(40) + opts.toast : "",
    RULE,
    "❯ ",
    RULE,
    "  Sonnet 5 · ctx 96% · 5h 15%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");
}
const CHAT = ["❯ Reply with just the word OK.", "", "⏺ OK", "", "✻ Cogitated for 1s · done 3:23 AM", ""];
const echo = (cmd: string, result: string) => [`❯ ${cmd}`, `  ⎿  ${result}`, ""];
const SONNET_SET = echo("/model claude-sonnet-5", "Set model to Sonnet 5 and saved as your default for new sessions");

describe("lastSettledSwitch", () => {
  test("真机屏：最底下一条 + 之后的正文行数", () => {
    expect(lastSettledSwitch(MODEL_SET, "model")).toEqual({
      command: "❯ /model claude-sonnet-5",
      result: "Set model to Sonnet 5 and saved as your default for new sessions",
      tail: 0,
    });
    expect(lastSettledSwitch(MODEL_THEN_EFFORT, "model")?.command).toBe("❯ /model claude-haiku-4-5-20251001");
    expect(lastSettledSwitch(MODEL_THEN_EFFORT, "model")?.tail).toBe(2);
    expect(lastSettledSwitch(MODEL_THEN_EFFORT, "effort")?.command).toBe("❯ /effort medium");
  });

  test("输入框里打着但没提交的命令不算", () => {
    const typed = screen([...CHAT]).replace(/^❯ $/m, "❯ /model claude-sonnet-5");
    expect(lastSettledSwitch(typed, "model")).toBeNull();
  });
});

describe("switchRejectionToast", () => {
  test("ultracode 前提不满足的 toast", () => {
    const p = screen(CHAT, { toast: "Ultracode needs dynamic workflows enabled (see /config). Valid options are: low, medium, high" });
    expect(switchRejectionToast(p)).toMatch(/^Ultracode needs dynamic workflows/);
    expect(switchRejectionToast(screen(CHAT))).toBeNull();
  });
});

describe("runSwitchCommand（假 pane 序列）", () => {
  /** 第一次 capture 返回 before，之后每拍按序返回 seq，最后一屏重复 */
  function fakeIO(before: string, seq: string[]) {
    const sent: string[] = [];
    let i = -1;
    const io: SwitchIO = {
      capture: async () => {
        const p = i < 0 ? before : seq[Math.min(i, seq.length - 1)]!;
        i++;
        return p;
      },
      sendLine: async (_t, text) => { sent.push(`line:${text}`); },
      sendKey: async (_t, k) => { sent.push(`key:${k}`); },
      sleep: async () => {},
    };
    return { io, sent };
  }
  const IDLE = screen(CHAT);
  const SETTLED = screen([...CHAT, ...SONNET_SET]);

  test("弹框 → 代按 → 落地 = confirmed", async () => {
    const { io, sent } = fakeIO(IDLE, [SWITCH_MODEL, SETTLED]);
    const r = await runSwitchCommand("w", "model", "claude-sonnet-5", { io });
    expect(r.outcome).toBe("confirmed");
    expect(sent).toEqual(["line:/model claude-sonnet-5", "key:Enter"]);
  });

  test("没弹框直接落地 = applied", async () => {
    const { io, sent } = fakeIO(IDLE, [IDLE, SETTLED]);
    expect((await runSwitchCommand("w", "model", "claude-sonnet-5", { io })).outcome).toBe("applied");
    expect(sent).toEqual(["line:/model claude-sonnet-5"]);
  });

  test("别的框（切 model 撞上 effort 框）→ foreign，一个键都不按", async () => {
    const { io, sent } = fakeIO(IDLE, [CHANGE_EFFORT]);
    const r = await runSwitchCommand("w", "model", "claude-sonnet-5", { io });
    expect(r.outcome).toBe("foreign");
    expect(sent).toEqual(["line:/model claude-sonnet-5"]);
  });

  test("按了框不消失 → 最多按 3 次，timeout 带着框返回", async () => {
    const { io, sent } = fakeIO(IDLE, [SWITCH_MODEL]);
    const r = await runSwitchCommand("w", "model", "claude-sonnet-5", { io });
    expect(r.outcome).toBe("timeout");
    expect(r.prompt?.kind).toBe("model");
    expect(sent.filter((s) => s === "key:Enter")).toHaveLength(3);
  });

  test("最后一拍才按到框：重看一眼，不拿按键前的旧屏报 timeout", async () => {
    const { io } = fakeIO(IDLE, [SWITCH_MODEL, SETTLED]);
    const r = await runSwitchCommand("w", "model", "claude-sonnet-5", { io, ticks: 1 });
    expect(r.outcome).toBe("confirmed");
    expect(detectSwitchConfirmPrompt(r.pane)).toBeNull();
  });

  test("代按后框关了、回到输入框但结果行没留下 → 仍算 confirmed", async () => {
    const { io } = fakeIO(IDLE, [CHANGE_EFFORT, IDLE]);
    expect((await runSwitchCommand("w", "effort", "high", { io })).outcome).toBe("confirmed");
  });

  test("全屏满屏：旧 /model 回显被顶出屏幕、条数不涨，按位置仍认出落地", async () => {
    const filler = Array.from({ length: 15 }, (_, i) => `⏺ line ${i}`);
    const conv = [...echo("/model claude-haiku-4-5-20251001", "Set model to Haiku 4.5"), ...filler, "✻ done", ""];
    expect(conv).toHaveLength(20);
    const before = screen(conv);
    const after = screen([...conv, ...SONNET_SET]);
    expect(countSettledSwitchCommands(after, "model")).toBe(countSettledSwitchCommands(before, "model"));
    const { io } = fakeIO(before, [after]);
    expect((await runSwitchCommand("w", "model", "claude-sonnet-5", { io })).outcome).toBe("applied");
  });

  test("同一条命令重复、屏上还没变化 → 不提前放行", async () => {
    const before = screen([...CHAT, ...SONNET_SET]);
    const { io } = fakeIO(before, [before]);
    expect((await runSwitchCommand("w", "model", "claude-sonnet-5", { io, ticks: 3 })).outcome).toBe("timeout");
  });

  test("ultracode 被拒（toast）→ rejected 带原因，立刻返回", async () => {
    const rej = screen(CHAT, { toast: "Ultracode needs dynamic workflows enabled (see /config). Valid options are: low, medium" });
    const { io } = fakeIO(IDLE, [rej]);
    const r = await runSwitchCommand("w", "effort", "ultracode", { io });
    expect(r.outcome).toBe("rejected");
    expect(r.reason).toMatch(/needs dynamic workflows/);
  });

  test("ultracode 被拒（⎿ 结果行）→ rejected", async () => {
    const rej = screen([...CHAT, ...echo("/effort ultracode", "Ultracode needs dynamic workflows enabled (see /config).")]);
    const { io } = fakeIO(IDLE, [rej]);
    expect((await runSwitchCommand("w", "effort", "ultracode", { io })).outcome).toBe("rejected");
  });

  test("ultracode：框写 xhigh 也代按", async () => {
    const xhighDialog = CHANGE_EFFORT.replace("Yes, switch to high", "Yes, switch to xhigh");
    const done = screen([...CHAT, ...echo("/effort ultracode", "Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration")]);
    const { io, sent } = fakeIO(IDLE, [xhighDialog, done]);
    expect((await runSwitchCommand("w", "effort", "ultracode", { io })).outcome).toBe("confirmed");
    expect(sent).toEqual(["line:/effort ultracode", "key:Enter"]);
  });
});
