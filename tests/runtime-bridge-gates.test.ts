/**
 * bridge 侧按运行时声明（RuntimeControl）分流的四个闸口，Codex 接进来后复审抓到它们还在套 CC 判据：
 * - 人类消息抢占 / 手动打断的闸见 tests/interrupt-gate.test.ts
 * - Stop 后的屏幕复核只对 idleSource=pane 的运行时（stopNeedsPaneRecheck）
 * - wedge 卡死判定只对 paneHeuristics 的运行时（wedgeJudgedByPane）
 * - interruptOnlyWhenBusy：空闲的 Codex 不发 Esc，返回空数组让调用方回报「无需打断」（interruptVia）
 * - 用量抓取只往 CC 窗口敲 /status（claudeCodeWindows）
 */
import { describe, expect, test } from "bun:test";
import { wedgeJudgedByPane } from "../src/bridge/wedge-watcher.js";
import { paneIdleVerdict, paneLooksIdle } from "../src/lib/tmux-helper.js";
import { interruptVia, stopNeedsPaneRecheck, type InterruptIO } from "../src/lib/runtimes/window-ops.js";
import { claudeCodeWindows } from "../src/lib/runtimes/index.js";

const CODEX_IDLE = [
  "› 上一轮的回答……",
  "",
  "› Ask Codex to do anything",
  "  gpt-5.5 high · 100% context left · ? for shortcuts",
].join("\n");
const CODEX_BUSY = [
  "› 帮我跑测试",
  "• Working (12s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  gpt-5.5 high · 98% context left",
].join("\n");

function fakeIO(pane: string | Error) {
  const sent: string[] = [];
  let captures = 0;
  const io: InterruptIO = {
    capture: async () => {
      captures++;
      if (pane instanceof Error) throw pane;
      return pane;
    },
    sendKey: async (k) => {
      sent.push(k);
    },
  };
  return { io, sent, captures: () => captures };
}

describe("前提：CC 的屏幕判据套在 Codex 上是错的", () => {
  test("空闲和忙着的 Codex 画面都被判成 busy，paneLooksIdle 也永远不认", () => {
    expect(paneIdleVerdict(CODEX_IDLE)).toBe("busy");
    expect(paneIdleVerdict(CODEX_BUSY)).toBe("busy");
    expect(paneLooksIdle(CODEX_IDLE)).toBe(false);
  });
});

describe("interruptVia：interruptOnlyWhenBusy", () => {
  test("空闲的 Codex：一个键都不发，返回空数组", async () => {
    const f = fakeIO(CODEX_IDLE);
    expect(await interruptVia(f.io, "codex")).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test("回合在跑的 Codex：只发一次 Esc", async () => {
    const f = fakeIO(CODEX_BUSY);
    expect(await interruptVia(f.io, "codex")).toEqual(["Escape"]);
    expect(f.sent).toEqual(["Escape"]);
  });

  test("抓屏失败按空闲算：宁可不按", async () => {
    const f = fakeIO(new Error("tmux gone"));
    expect(await interruptVia(f.io, "codex")).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test("CC / 缺省发 Esc、Pi 发 C-c：都不看屏幕，无条件发", async () => {
    // CC 用 Esc：主回合空闲、只剩后台子 agent 时 C-c 会停掉全部后台 agent，Esc 不会（2026-09-28 沙箱实测）
    for (const [rt, key] of [["claude-code", "Escape"], [undefined, "Escape"], ["pi", "C-c"]] as const) {
      const f = fakeIO(CODEX_IDLE);
      expect(await interruptVia(f.io, rt)).toEqual([key]);
      expect(f.sent).toEqual([key]);
      expect(f.captures()).toBe(0);
    }
  });

  test("发键失败照旧抛出（调用方各自报错）", async () => {
    const io: InterruptIO = {
      capture: async () => CODEX_BUSY,
      sendKey: async () => {
        throw new Error("send-keys failed");
      },
    };
    await expect(interruptVia(io, "codex")).rejects.toThrow("send-keys failed");
  });
});

describe("stopNeedsPaneRecheck：Stop 后的屏幕复核", () => {
  test("只有 CC（idleSource=pane）复核；hook 驱动的 Pi / Codex 直接信 Stop", () => {
    expect(stopNeedsPaneRecheck(undefined)).toBe(true);
    expect(stopNeedsPaneRecheck("claude-code")).toBe(true);
    expect(stopNeedsPaneRecheck("pi")).toBe(false);
    expect(stopNeedsPaneRecheck("codex")).toBe(false);
  });
});

describe("wedgeJudgedByPane：卡死判定", () => {
  test("只有 CC 按屏幕静止判卡死；Pi / Codex 的空闲画面本来就不变", () => {
    expect(wedgeJudgedByPane(undefined)).toBe(true);
    expect(wedgeJudgedByPane("claude-code")).toBe(true);
    expect(wedgeJudgedByPane("pi")).toBe(false);
    expect(wedgeJudgedByPane("codex")).toBe(false);
  });
});

describe("claudeCodeWindows：用量抓取往哪些窗口敲 /status", () => {
  test("只认 registry 里的 CC 窗口：Pi / Codex / 查不到的窗口都不碰", () => {
    const agents = [
      { name: "agent-cc", runtime: "claude-code" },
      { name: "agent-old" }, // 老 agent 没有 runtime 字段 = CC
      { name: "agent-pi", runtime: "pi" },
      { name: "agent-codex", runtime: "codex" },
    ];
    const wins = ["master", "agent-cc", "agent-old", "agent-pi", "agent-codex", "agent-orphan", ""];
    expect(claudeCodeWindows(wins, agents)).toEqual(["agent-cc", "agent-old"]);
  });
});
