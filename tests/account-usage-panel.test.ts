/**
 * CC 2.1.301 实测 pane（tests/fixtures/account-usage/，已脱敏）回归：
 * 补全菜单选中项的缩进 ❯ 不能当输入行（否则恒报 probe_input_unexpected）；
 * Usage tab 异步加载时原地等，不能再按 → 翻走（否则报 probe_no_usage_tab）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runUsageProbe, type ProbeTmux } from "../src/bridge/account-usage-probe.ts";
import { parseUsagePanel, typedRecheckOk, usagePanelLoading, usagePanelVisible } from "../src/lib/account-usage-panel.ts";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/account-usage", name), "utf8");
const MENU = fx("status-typed-menu-cc2.1.301.txt");
const LOADING = fx("usage-loading-cc2.1.301.txt");
const LOADED = fx("usage-loaded-cc2.1.301.txt");

describe("typedRecheckOk（CC 2.1.301 补全菜单）", () => {
  test("真实 pane：输入行顶格 ❯(NBSP)/status、菜单选中项缩进 ❯ → 通过", () => {
    expect(MENU).toMatch(/^ {2}❯ \/status\s+Show Claude Code status/m);
    expect(typedRecheckOk(MENU, "/status")).toBe(true);
  });

  test("同一 pane 输入行混入他人内容 → 仍撤退", () => {
    expect(typedRecheckOk(MENU.replace(/^❯\s\/status$/m, "❯ 帮我/status"), "/status")).toBe(false);
  });

  test("同一 pane 回合已开 → 仍撤退", () => {
    expect(typedRecheckOk(MENU + "\n✻ Cooking… (esc to interrupt)", "/status")).toBe(false);
  });

  test("只有缩进的菜单 ❯、没有输入行 → 保守撤退", () => {
    expect(typedRecheckOk(MENU.replace(/^❯\s\/status$/m, ""), "/status")).toBe(false);
  });
});

describe("Usage tab 异步加载", () => {
  test("加载帧：认得出在加载、不算可读面板", () => {
    expect(usagePanelLoading(LOADING)).toBe(true);
    expect(usagePanelVisible(LOADING)).toBe(false);
  });

  test("加载完的真实帧能解析出两条量", () => {
    expect(usagePanelLoading(LOADED)).toBe(false);
    expect(usagePanelVisible(LOADED)).toBe(true);
    const u = parseUsagePanel(LOADED, Date.now());
    expect([u.sessionPct, u.weekPct]).toEqual([27, 31]);
    expect(u.weekResets).toContain("Oct 19 at 10pm");
  });
});

/** 按真实顺序回放：敲入 → 菜单帧；Enter → Status tab；→ 依次 Config / Usage(加载 N 帧后加载完) */
function replayTmux(loadingFrames: number) {
  const STATUS_TAB = "❯ /status\n  Settings  Status   Config   Usage   Stats\n  Version:   2.1.301\n  Esc to cancel\n";
  const CONFIG_TAB = "❯ /status\n  Settings  Status   Config   Usage   Stats\n  ❯ Auto-compact   true\n  Esc to close\n";
  let screen = "Claude Code\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
  let onUsage = false;
  let left = loadingFrames;
  const keys: string[] = [];
  const tmux: ProbeTmux = {
    newSession: async () => "$10",
    capture: async () => {
      if (!onUsage) return screen;
      return left-- > 0 ? LOADING : LOADED;
    },
    sendLiteral: async (_id, text) => { keys.push(text); screen = MENU; },
    sendKey: async (_id, key) => {
      keys.push(key);
      if (key === "Enter") screen = STATUS_TAB;
      else if (key === "Right" && screen === STATUS_TAB) screen = CONFIG_TAB;
      else if (key === "Right" && screen === CONFIG_TAB) onUsage = true;
      else if (key === "Right") onUsage = false; // 加载中再按 → 就翻到 Stats，读不到
    },
    nameOf: async () => "x",
    kill: async () => {},
  };
  return { tmux, keys };
}

function deps(tmux: ProbeTmux) {
  let now = new Date(2026, 9, 16, 15, 0).getTime(); // session 重置 5:10pm 在 5.2h 内
  return { tmux, claudeBin: () => "/usr/local/bin/claude", sleep: async (ms: number) => void (now += ms), now: () => now,
    makeDir: () => "/tmp/fake-probe-dir", removeDir: () => {}, timeoutMs: 5_000 };
}

describe("runUsageProbe 回放 CC 2.1.301", () => {
  test("Usage 加载 3 帧：原地等，不多按 →，读到 27% / 31%", async () => {
    const t = replayTmux(3);
    const r = await runUsageProbe(() => {}, deps(t.tmux));
    expect(r.ok ? [r.usage.sessionPct, r.usage.weekPct] : r.reason).toEqual([27, 31]);
    expect(t.keys).toEqual(["/status", "Enter", "Right", "Right"]);
  });

  test("一直在加载：等满上限后明确失败，不无限等", async () => {
    const t = replayTmux(1_000);
    const r = await runUsageProbe(() => {}, deps(t.tmux));
    expect(r.ok ? "ok" : r.reason).toBe("probe_no_usage_tab");
  });
});
