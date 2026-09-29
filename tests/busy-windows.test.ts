/**
 * 升级闸门按运行时判忙闲：Pi 窗口拿 Claude Code 的判据恒为「忙」，自动更新 10 天等不到全员空闲。
 * 样本同 tests/pi-idle-verdict.test.ts（真实 capture-pane 抄的）。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paneLooksIdle } from "../src/lib/tmux-helper.js";
import { windowLooksIdle } from "../src/lib/busy-windows.js";

const RULE = "─".repeat(52);
const piPane = (topRule: string) =>
  [topRule, RULE, "~/projects/x (develop) • agent-pi_x", "↑17M ↓2.8M R1032M (auto)", "🔗 agent-pi_x 💬 pi--10", ""].join("\n");
const PI_IDLE = piPane(RULE);
const PI_BUSY = piPane("── ⠧ Working " + "─".repeat(40));
const CC_IDLE = [`${"─".repeat(40)} x ─`, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const CC_BUSY = ["✶ Processing… (2m 12s · ↓ 7.8k tokens)", "", CC_IDLE].join("\n");

// Codex（0.158 实抓）：空闲是「» Ask Codex…」+ 上一回合的「Worked for …」，在跑是「• Working (12s • esc to interrupt)」
const CODEX_IDLE = ["  Worked for 11m 10s · 23:02", "» Ask Codex to do anything", "  GPT-6-Sol ultra · ~/x · Main [default]", "  ? for shortcuts"].join("\n");
const CODEX_BUSY = ["• Working (12s • esc to interrupt)", "» Ask Codex to do anything", "  GPT-6-Sol ultra · ~/x · Main [default]"].join("\n");

describe("windowLooksIdle", () => {
  test("Codex 空闲窗口不再恒判忙（曾挡住自动更新一整晚），在跑照样挡", () => {
    expect(windowLooksIdle("codex", CODEX_IDLE)).toBe(true);
    expect(windowLooksIdle("codex", CODEX_BUSY)).toBe(false);
  });

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

const wallFx = (f: string): string => readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");

describe("撞墙等待不算空闲（T41a：升级会重启全员，CC 排好的自动续跑跟着丢）", () => {
  test("80 列周额度倒计时被截成「esc to ca…」：paneLooksIdle 判空闲，升级闸判忙", () => {
    const p = wallFx("walled-weekly-80col");
    expect(paneLooksIdle(p)).toBe(true);
    expect(windowLooksIdle(undefined, p)).toBe(false);
  });
  test("其余倒计时、额度菜单 → 忙；LP 在跑、普通草稿照旧按 CC 判据", () => {
    for (const f of ["walled", "walled-when-resets", "walled-shortly", "lp-off-offer", "menu-no-lp", "menu-on-credits"]) {
      expect([f, windowLooksIdle("claude-code", wallFx(f))]).toEqual([f, false]);
    }
    expect(windowLooksIdle(undefined, wallFx("draft"))).toBe(paneLooksIdle(wallFx("draft")));
  });
});

