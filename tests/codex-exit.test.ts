/**
 * 优雅退出的按键序列（runtimes/graceful-exit.ts）+ Codex 的清场（codex-exit.ts）+ 就绪判据只看 pane 尾部。
 *
 * 审查实测（Codex 0.153.4）：默认序列的 Esc×3 + 守卫 Esc 会把 Codex 送进 backtrack 回溯遮罩，
 * "/quit" 的 q 关掉遮罩、"uit" 当成一轮用户消息发给模型。这里钉住：Codex 绝不连发 Esc。
 * CC / Pi 的默认序列见 graceful-exit.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { decideDelivery } from "../src/lib/codex-thread.js";
import { codexBusy, codexExitPrelude, codexOverlayOpen } from "../src/lib/runtimes/codex-exit.js";
import { createCodexAdapter, type CodexAdapterDeps } from "../src/lib/runtimes/codex.js";
import { gracefulExitWindow } from "../src/lib/runtimes/graceful-exit.js";
import { managedFor, type WindowOps } from "../src/lib/runtimes/index.js";

const SID = "019a0000-1111-7222-8333-444455556666";
const OTHER = "019a0000-9999-7222-8333-444455556666";

/** 事件按发生顺序记：key:<名> / text:<字面> */
function scriptedWindow(panes: string[], kids: number[] = []) {
  const events: string[] = [];
  let i = 0;
  const win: WindowOps = {
    name: "agent-x",
    target: "master:agent-x",
    capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
    sendLine: async (t) => { events.push(`text:${t}`, "key:Enter"); },
    sendLiteral: async (t) => { events.push(`text:${t}`); },
    sendKey: async (k) => { events.push(`key:${k}`); },
    sendEscape: async () => { events.push("key:Escape"); },
    getOption: async () => null,
    setOption: async () => true,
    childPids: async () => kids,
    sleep: async () => {},
  };
  return { win, events };
}

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
const CODEX_OVERLAY = [
  "/ T R A N S C R I P T / / / / / /",
  "user: 帮我跑测试",
  "↑/↓ to scroll   q to quit   esc to edit prev   enter to edit message",
].join("\n");
const SHELL = "➜  work git:(main)";

describe("graceful-exit：Codex 绝不连发 Esc", () => {
  const codex = () => createCodexAdapter({ now: () => 0 } as Partial<CodexAdapterDeps>);

  test("空闲：一个 Esc 都不发，直接 /quit + Enter", async () => {
    const { win, events } = scriptedWindow([CODEX_IDLE, SHELL]);
    expect(await gracefulExitWindow(win, codex())).toBe(true);
    expect(events).toEqual(["text:/quit", "key:Enter"]);
  });

  test("回合在跑：恰好一个 Esc，等回合停下再 /quit", async () => {
    const { win, events } = scriptedWindow([CODEX_BUSY, CODEX_BUSY, CODEX_IDLE, SHELL]);
    expect(await gracefulExitWindow(win, codex())).toBe(true);
    expect(events).toEqual(["key:Escape", "text:/quit", "key:Enter"]);
  });

  test("回合一直停不下：仍然只发一个 Esc", async () => {
    const { win, events } = scriptedWindow([...Array(25).fill(CODEX_BUSY), SHELL]);
    await gracefulExitWindow(win, codex());
    expect(events.filter((e) => e === "key:Escape")).toHaveLength(1);
  });

  test("回溯遮罩开着：先按 q 关掉（绝不按 Enter），再 /quit", async () => {
    const { win, events } = scriptedWindow([CODEX_OVERLAY, CODEX_IDLE, SHELL]);
    expect(await gracefulExitWindow(win, codex())).toBe(true);
    expect(events).toEqual(["text:q", "text:/quit", "key:Enter"]);
  });

  test("/quit 之后遮罩还在：只补一次 q，不补 Enter", async () => {
    const { win, events } = scriptedWindow([CODEX_IDLE, CODEX_OVERLAY, CODEX_OVERLAY, CODEX_OVERLAY, SHELL]);
    expect(await gracefulExitWindow(win, codex())).toBe(true);
    expect(events).toEqual(["text:/quit", "key:Enter", "text:q"]);
  });

  test("已经在 shell：什么都不发", async () => {
    const { win, events } = scriptedWindow([SHELL]);
    expect(await codexExitPrelude(win)).toBe("at-shell");
    expect(events).toEqual([]);
  });

  test("判据只看底部：历史里提到 esc to interrupt / edit message 不算", () => {
    const history = ["聊到 esc to interrupt 与 enter to edit message 的区别", ...Array(10).fill("……"), CODEX_IDLE].join("\n");
    expect(codexBusy(history)).toBe(false);
    expect(codexOverlayOpen(history)).toBe(false);
    expect(codexBusy(CODEX_BUSY)).toBe(true);
    expect(codexOverlayOpen(CODEX_OVERLAY)).toBe(true);
    // backtrack 刚挂上的提示不是遮罩
    expect(codexOverlayOpen(`${CODEX_IDLE}\n  esc again to edit previous message`)).toBe(false);
  });

  test("Codex 声明：只在忙时打断", () => {
    expect(managedFor("codex")!.control.interruptOnlyWhenBusy).toBe(true);
    expect(managedFor("claude-code")!.control.interruptOnlyWhenBusy).toBeUndefined();
    expect(managedFor("pi")!.control.interruptOnlyWhenBusy).toBeUndefined();
  });
});

describe("waitReady：resume 回放的历史不算对话框 / 占用", () => {
  const budget = { rounds: 3, pollMs: 1 };
  const deps = (): Partial<CodexAdapterDeps> => ({ now: () => 0, resolveBin: async () => "/opt/codex" });

  test("历史里提到 Update available / Do you trust（不在底部、没有选项行）→ 不是 blocked-dialog", async () => {
    const a = createCodexAdapter(deps());
    const replay = [
      "• 我查了：Codex 启动时会弹 Update available 和 Do you trust 两种对话框。",
      ...Array(20).fill("  ……"),
      CODEX_IDLE,
    ].join("\n");
    const { win, events } = scriptedWindow(["~ %", replay], [4242]);
    await a.beforeLaunch!(win);
    expect(await a.waitReady(win, budget)).toEqual({ ready: false, reason: "timeout" });
    expect(events).toEqual([]);
  });

  test("底部关键词但没有对话框结构 → 不算", async () => {
    const a = createCodexAdapter(deps());
    const { win } = scriptedWindow(["~ %", `• 结论：Update available 那个框要人工处理\n${CODEX_IDLE}`], [4242]);
    await a.beforeLaunch!(win);
    expect(await a.waitReady(win, budget)).toMatchObject({ reason: "timeout" });
  });

  test("历史里有 active writer、codex 还在跑 → 不是 occupied", async () => {
    const a = createCodexAdapter(deps());
    const { win } = scriptedWindow(["~ %", `• 上次报 thread x already has an active writer，已处理\n${CODEX_IDLE}`], [4242]);
    await a.beforeLaunch!(win);
    expect(await a.waitReady(win, budget)).toMatchObject({ reason: "timeout" });
  });
});

describe("锁文件名不像线程 id：不写进 registry、不切过去", () => {
  test("discoverSessionId 过滤非 UUID", async () => {
    const a = createCodexAdapter({
      now: () => 0,
      childPids: async () => [4242],
      heldThreadIds: async () => ["../../etc", OTHER],
    } as Partial<CodexAdapterDeps>);
    expect(await a.discoverSessionId!({ windowName: "w", cwd: "/w", exclude: SID, timeoutMs: 0 })).toEqual({
      sessionId: OTHER,
      via: "thread-writer-lock",
    });
    const b = createCodexAdapter({ now: () => 0, childPids: async () => [4242], heldThreadIds: async () => ["weird"] } as Partial<CodexAdapterDeps>);
    expect(await b.discoverSessionId!({ windowName: "w", cwd: "/w", timeoutMs: 0 })).toBeNull();
  });

  test("decideDelivery：唯一持有的锁不是线程 id → ambiguous，不 switch", () => {
    expect(decideDelivery(SID, ["weird"])).toEqual({ action: "ambiguous", held: ["weird"] });
    expect(decideDelivery(SID, ["weird", OTHER])).toEqual({ action: "switch", sid: OTHER });
  });
});
