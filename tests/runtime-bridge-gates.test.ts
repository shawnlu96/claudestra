/**
 * bridge 侧按运行时声明（RuntimeControl）分流的四个闸口，Codex 接进来后复审抓到它们还在套 CC 判据：
 * - Discord 入站「忙就先打断」只对 preemptOnHumanMessage + paneHeuristics 的运行时（preemptIfBusy）
 * - Stop 后的屏幕复核只对 idleSource=pane 的运行时（stopNeedsPaneRecheck）
 * - wedge 卡死判定只对 paneHeuristics 的运行时（wedgeJudgedByPane）
 * - interruptOnlyWhenBusy：空闲的 Codex 不发 Esc，返回空数组让调用方回报「无需打断」（interruptVia）
 */
import { describe, expect, test } from "bun:test";
import { wedgeJudgedByPane } from "../src/bridge/wedge-watcher.js";
import { paneIdleVerdict, paneLooksIdle } from "../src/lib/tmux-helper.js";
import { interruptVia, preemptIfBusy, stopNeedsPaneRecheck, type InterruptIO } from "../src/lib/runtimes/window-ops.js";

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

  test("CC / Pi / 缺省：不看屏幕，照旧无条件发 C-c", async () => {
    for (const rt of ["claude-code", "pi", undefined]) {
      const f = fakeIO(CODEX_IDLE);
      expect(await interruptVia(f.io, rt)).toEqual(["C-c"]);
      expect(f.sent).toEqual(["C-c"]);
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

describe("preemptIfBusy：Discord 入站的抢占打断", () => {
  function spy(verdict: string, keys: readonly string[] = ["C-c"]) {
    const calls = { verdict: 0, interrupt: [] as (string | null | undefined)[] };
    const verdictOf = async () => {
      calls.verdict++;
      return verdict;
    };
    const interrupt = async (_t: string, rt: string | null | undefined) => {
      calls.interrupt.push(rt);
      return keys;
    };
    return { calls, verdictOf, interrupt };
  }

  test("CC 在忙：打断", async () => {
    const s = spy("busy");
    expect(await preemptIfBusy("w", undefined, s.verdictOf, s.interrupt)).toBe(true);
    expect(s.calls.interrupt).toEqual([undefined]);
  });

  test("CC 空闲 / 判据可疑：不打断", async () => {
    for (const v of ["idle", "unknown"]) {
      const s = spy(v);
      expect(await preemptIfBusy("w", "claude-code", s.verdictOf, s.interrupt)).toBe(false);
      expect(s.calls.interrupt).toEqual([]);
    }
  });

  test("Codex / Pi：连屏幕都不看，绝不打断（CC 判据对它们恒判 busy）", async () => {
    for (const rt of ["codex", "pi"]) {
      const s = spy("busy", ["Escape"]);
      expect(await preemptIfBusy("w", rt, s.verdictOf, s.interrupt)).toBe(false);
      expect(s.calls.verdict).toBe(0);
      expect(s.calls.interrupt).toEqual([]);
    }
  });

  test("发键失败：返回 false，不抛（照常投递）", async () => {
    const r = await preemptIfBusy("w", undefined, async () => "busy", async () => {
      throw new Error("tmux gone");
    });
    expect(r).toBe(false);
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
