/**
 * 升级闸门按运行时判忙闲：Pi 窗口拿 Claude Code 的判据恒为「忙」，自动更新 10 天等不到全员空闲。
 * 样本同 tests/pi-idle-verdict.test.ts（真实 capture-pane 抄的）。
 */
import { describe, test, expect } from "bun:test";
import { paneLooksIdle } from "../src/lib/tmux-helper.js";
import { windowLooksIdle } from "../src/lib/busy-windows.js";

const RULE = "─".repeat(52);
const piPane = (topRule: string) =>
  [topRule, RULE, "~/projects/x (develop) • agent-pi_x", "↑17M ↓2.8M R1032M (auto)", "🔗 agent-pi_x 💬 pi--10", ""].join("\n");
const PI_IDLE = piPane(RULE);
const PI_BUSY = piPane("── ⠧ Working " + "─".repeat(40));
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✶ Processing… (2m 12s · ↓ 7.8k tokens)", "", CC_IDLE].join("\n");

describe("windowLooksIdle", () => {
  test("Pi 空闲窗口：CC 判据说忙（旧 bug），按运行时判是空闲", () => {
    expect(paneLooksIdle(PI_IDLE)).toBe(false);
    expect(windowLooksIdle("pi", PI_IDLE)).toBe(true);
  });

  test("Pi 在跑（working 横线）→ 忙，照样挡升级", () => {
    expect(windowLooksIdle("pi", PI_BUSY)).toBe(false);
  });

  test("Claude Code 窗口判据不变（runtime 缺省 = claude-code）", () => {
    expect(windowLooksIdle(undefined, CC_IDLE)).toBe(true);
    expect(windowLooksIdle(undefined, CC_BUSY)).toBe(false);
    expect(windowLooksIdle("claude-code", CC_BUSY)).toBe(false);
  });
});
