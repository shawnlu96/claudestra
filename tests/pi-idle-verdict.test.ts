/**
 * Pi 窗口的忙闲判据（2026-09-21：`⚠️ [wedge] agent-pi_bn_market_maker 忙闲判据失效`
 * 每 5 分钟一条刷了一上午——CC 那套判据在 Pi 画面上恒判 unknown）。
 *
 * 样本按真实 capture-pane 抄：两条 `────` 夹着输入行，下面是状态行；
 * 在忙时上面那条横线变成 `── ⠧ Working ─────`。
 */
import { describe, test, expect } from "bun:test";
import { paneIdleVerdict, piPaneIdleVerdict } from "../src/lib/tmux-helper.js";

const RULE = "─".repeat(52);

const PI_IDLE = [
  "╰" + "─".repeat(50) + "╯",
  RULE,
  "",
  RULE,
  "~/projects/bn_market_maker (develop) • agent-pi_bn_market_maker",
  "↑17M ↓2.8M R1032M $7.002 ?/1.0M (auto)  deepseek-v4.1-flash • max",
  "🔗 agent-pi_bn_market_maker 💬 pi--10 🔌 MCP: 2 servers enabled",
  "",
  "",
].join("\n");

const PI_BUSY = [
  "── ⠧ Working " + "─".repeat(40),
  RULE,
  "~/projects/bn_market_maker (develop) • agent-pi_bn_market_maker",
  "↑16M ↓2.4M R955M CH99.9% $7.002 58.5%/1.0M (auto)",
  "🔗 agent-pi_bn_market_maker 💬 pi--10 🔌 MCP: 2 servers enabled",
  "",
].join("\n");

const CC_IDLE = ["╭" + "─".repeat(60) + "╮", "❯ ", "╰" + "─".repeat(60) + "╯", "  bypass permissions on"].join("\n");

describe("piPaneIdleVerdict", () => {
  test("空闲：两条纯横线 + 我们自己的 🔗 状态行", () => {
    expect(piPaneIdleVerdict(PI_IDLE)).toBe("idle");
  });

  test("在忙：working 指示器是一条内嵌文字的横线", () => {
    expect(piPaneIdleVerdict(PI_BUSY)).toBe("busy");
  });

  test("不认 Working 这个词——指示器文案可被扩展改写", () => {
    expect(piPaneIdleVerdict(PI_BUSY.replace("⠧ Working", "⣾ 正在编译"))).toBe("busy");
  });

  test("bridge 断开时状态行变样，仍认得出是 Pi 窗口", () => {
    expect(piPaneIdleVerdict(PI_IDLE.replace(/🔗 .*/, "⚠️ bridge 断开"))).toBe("idle");
  });

  test("没有我们的状态行 → 返回 null，退回 CC 那套（不改既有行为）", () => {
    expect(piPaneIdleVerdict(PI_IDLE.replace(/🔗 .*/, ""))).toBeNull();
    expect(piPaneIdleVerdict(CC_IDLE)).toBeNull();
  });

  test("尾部成片空行不能把状态行挤出窗口", () => {
    expect(piPaneIdleVerdict(PI_IDLE + "\n".repeat(30))).toBe("idle");
  });
});

describe("paneIdleVerdict 接上 Pi 分支", () => {
  test("Pi 窗口不再恒 unknown", () => {
    expect(paneIdleVerdict(PI_IDLE)).toBe("idle");
    expect(paneIdleVerdict(PI_BUSY)).toBe("busy");
  });

  test("Claude Code 窗口走原路", () => {
    expect(paneIdleVerdict(CC_IDLE)).toBe("idle");
  });
});
