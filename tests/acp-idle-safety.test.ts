import { expect, test } from "bun:test";
import { exitIdleCodex } from "../src/lib/runtimes/codex-idle-exit.ts";
import { requireExitedCodex } from "../src/manager/acp-idle-restart.ts";
import { migrateIdleCodex } from "../src/manager/acp-idle-migration.ts";
import { agentIdle } from "../src/manager/agent-idle.ts";
import { scopeHttpTimeout } from "../src/bridge/http-timeout.ts";
import type { WindowOps } from "../src/lib/runtimes/types.ts";

function window(panes: string[], quits = true) {
  const keys: string[] = []; let submitted = false;
  const win = {
    capture: async () => submitted && quits ? "$ " : panes.length > 1 ? panes.shift()! : panes[0]!,
    sendLiteral: async (s: string) => { keys.push(s); },
    sendKey: async (s: string) => { keys.push(s); submitted = true; },
    sendEscape: async () => { throw new Error("自动迁移禁止 Esc"); },
    childPids: async () => submitted && quits ? [] : [123], sleep: async () => {},
  } as unknown as WindowOps;
  return { win, keys };
}
for (const pane of [
  "• Working (12s • esc to interrupt)\n›", "› 半句未发送的输入", "›\n› unfinished user input", "›\n  multiline unfinished input",
  "Update available\n› 1. Update now", "q to quit · enter to edit message\n›", "日志里没有可信输入框",
]) {
  test(`自动迁移遇到忙/未知画面不发任何键：${pane}`, async () => {
    const h = window([pane]); expect(await exitIdleCodex(h.win)).toBe(false); expect(h.keys).toEqual([]);
  });
}
test("第一帧空闲、第二帧忙：不退出；真正空闲只发 /quit+Enter", async () => {
  const race = window(["›", "• esc to interrupt\n›"]);
  expect(await exitIdleCodex(race.win)).toBe(false); expect(race.keys).toEqual([]);
  const idle = window(["›"]); expect(await exitIdleCodex(idle.win)).toBe(true); expect(idle.keys).toEqual(["/quit", "Enter"]);
});
test("/quit 不退出时没有 C-c、Esc 或强杀兜底", async () => {
  const h = window(["›"], false); expect(await exitIdleCodex(h.win)).toBe(false); expect(h.keys).toEqual(["/quit", "Enter"]);
});
test("退出后又出现进程：重启闸拒绝，不碰在跑会话", async () => {
  const info = { runtime: "codex", transport: "acp", acpRestartFrom: "tmux" };
  await expect(requireExitedCodex(info, ["@7"], async () => [123])).rejects.toThrow("窗口仍有进程");
  await requireExitedCodex(info, ["@7"], async () => []);
});
function fixture(exit: boolean, lock = true) {
  const agent = { runtime: "codex", transport: "tmux", acpPending: true, status: "active", channelId: "ch" };
  const reg: any = { agents: { "agent-old": agent, "agent-manual": { ...agent, acpPending: undefined } } };
  const seen: string[] = []; let busy = !exit;
  const deps: any = {
    load: async () => reg, save: async () => seen.push("save"), ready: async () => ({ ok: true }),
    lock: async () => lock ? { release: () => seen.push("unlock") } : null,
    claim: () => true, release: () => seen.push("release-restart"),
    hold: async () => (seen.push("hold"), "token"), unhold: async () => { seen.push("unhold"); },
    exit: async () => { seen.push("exit"); return !busy; },
  };
  const run = async () => { seen.push("restart"); return { ok: true }; };
  return { agent, deps, seen, run, finish: () => { busy = false; } };
}
test("忙时跳过，回合结束重试迁移；消息闸覆盖退出、registry 提交和 ACP 启动", async () => {
  const h = fixture(false);
  expect(await migrateIdleCodex(h.run, h.deps)).toEqual({ migrated: [], pending: ["agent-old"], failed: [] });
  expect(h.agent.transport).toBe("tmux"); expect(h.seen).not.toContain("save"); expect(h.seen).not.toContain("restart");
  h.seen.length = 0; h.finish();
  expect((await migrateIdleCodex(h.run, h.deps)).migrated).toEqual(["agent-old"]);
  expect(h.agent.transport).toBe("acp");
  expect(h.seen).toEqual(["hold", "exit", "save", "release-restart", "unlock", "restart", "unhold"]);
});
test("写锁拿不到时不退出、不改 registry", async () => {
  const h = fixture(true, false); await migrateIdleCodex(h.run, h.deps);
  expect(h.agent.transport).toBe("tmux"); expect(h.seen).toEqual([]);
});
test("ACP list 空闲只认当前线程宿主确认；忙、断线、旧线程与未知都按忙处理", async () => {
  const load = async () => ({ agents: { "agent-test": { runtime: "codex", transport: "acp", channelId: "ch", sessionId: "sid" } } }) as any;
  const pane = async () => { throw new Error("ACP 不抓日志画面"); };
  for (const r of [{ ok: true, busy: true, sessionId: "sid" }, { ok: false }, { ok: true, busy: false, sessionId: "old" }, {}]) {
    expect(await agentIdle("agent-test", load, pane, async () => r)).toBe(false);
  }
  expect(await agentIdle("agent-test", load, pane, async () => ({ ok: true, busy: false, sessionId: "sid" }))).toBe(true);
  expect(await agentIdle("agent-test", load, pane, async () => { throw new Error("offline"); })).toBe(false);
});
test("HTTP 只有 POST /clear 延长；同一连接后续请求恢复 30s", () => {
  const timeouts: number[] = []; const server = { timeout: (_req: Request, seconds: number) => { timeouts.push(seconds); } };
  for (const [method, path] of [["POST", "/api/v1/agents/test/clear"], ["GET", "/api/v1/agents/test/clear"], ["POST", "/api/v1/agents/test/messages"], ["GET", "/stats"]]) {
    scopeHttpTimeout(new Request(`http://localhost${path}`, { method }), server);
  }
  expect(timeouts).toEqual([240, 30, 30, 30]);
});

test("ACP 启动失败后下一轮安全重试，不重复 /quit 或改回 tmux", async () => {
  const h = fixture(true);
  expect((await migrateIdleCodex(async () => ({ ok: false }), h.deps)).failed).toEqual(["agent-old"]);
  expect(h.agent.transport).toBe("acp");
  h.seen.length = 0;
  expect((await migrateIdleCodex(h.run, h.deps)).migrated).toEqual(["agent-old"]);
  expect(h.seen).not.toContain("exit");
});
