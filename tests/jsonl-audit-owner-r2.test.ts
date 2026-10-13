/**
 * hardening-JWATCH1 第 2 轮审查补测：发送准备（channels.fetch）的 await 上被停，回来不再发旧会话正文；
 * bg 建子区在途时可信改名，装完的事件 / 结果归新名；已结束结果的改名迁移并发（A→B 未完时 B→C）最终落在最新名下。
 * 临时目录合成会话 + 内存 fake Discord / adapter + 测试状态目录（tests/preload.ts），不访问任何服务。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdapter } from "../src/bridge/adapters.ts";
import { activeBgTasksFor, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import { drainChannelWatcher, startWatching, stopWatchingByChannel } from "../src/bridge/jsonl-watcher.ts";
import { syncWatcherOwners } from "../src/bridge/watcher-ownership.ts";
import { ShellResultOwners } from "../src/bridge/watcher-ownership-results.ts";
import { ShellResults } from "../src/lib/bg-shell-results.ts";
import { projectJsonlPath } from "../src/lib/jsonl-cost.ts";
import * as sessionPaths from "../src/lib/session-path-resolve.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const say = (text: string) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text }] } }) + "\n";

/** 内存 Discord：channels.fetch 第一次停在闸口，send 记下正文 */
function fakeDiscord() {
  const sent: string[] = [];
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let n = 0;
  const channel = { send: async (o: { content: string } | string) => { sent.push(typeof o === "string" ? o : o.content); return { id: `m${++n}` }; } };
  const client = { channels: { fetch: async () => { reached.resolve(); await gate.promise; return channel; } } } as unknown as Parameters<typeof startWatching>[4];
  return { client, sent, reached: reached.promise, release: () => gate.resolve() };
}

describe("[验收线 1] 停下落在 Discord 发送准备的 await 上：放行后不发旧会话正文", () => {
  test("flush 卡在 channels.fetch → 按频道停 → 装新会话 → 放行：旧正文不 send", async () => {
    const CH = "jwatch-r2-discord-send", AG = "agent-jwatch-r2-send";
    const dir = tmp("jwatch-r2-send-");
    const file = (sid: string) => join(dir, `${sid}.jsonl`);
    const resolve = spyOn(sessionPaths, "resolveSessionPath").mockImplementation((_rt, _cwd, sid) => {
      try { appendFileSync(file(sid), ""); } catch { /* 目录已清 */ }
      return file(sid);
    });
    cleanups.push(() => { stopWatchingByChannel(CH); resolve.mockRestore(); });
    const d = fakeDiscord();
    await startWatching(AG, dir, "old-session", CH, d.client);
    appendFileSync(file("old-session"), say("old-session-secret"));
    const drained = drainChannelWatcher(CH, d.client);
    await d.reached;
    expect(stopWatchingByChannel(CH)).toBe(true);
    await startWatching(AG, dir, "new-session", CH, d.client);
    d.release();
    await drained;
    await Bun.sleep(50);
    expect(d.sent.filter((s) => s.includes("old-session-secret"))).toEqual([]);
  });
});

describe("[验收线 2] bg 建子区在途时可信改名：装完的事件与已结束结果归新名", () => {
  test("provisionThread 闸口里 rescan A→B，同轮结束的 shell：事件全标 B，B 快照有结果、A 为空", async () => {
    const root = tmp("jwatch-r2-bg-");
    const CH = "telegram:jwatch-r2-bg";
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let armed = true;
    registerAdapter({
      transport: "telegram", caps: { maxTextLen: 4000, buttons: false, edit: false, files: false, typing: false },
      send: async () => ({ messageIds: [] }),
      provisionThread: async () => {
        if (!armed) throw new Error("fake adapter retired");
        reached.resolve();
        await gate.promise;
        return { chatId: "telegram:jwatch-r2-thread" };
      },
    });
    cleanups.push(() => { armed = false; });
    const events: Array<[string, string]> = [];
    const unsub = subscribeEvents({ allow: (e) => e.chatId === CH }, (e) => { if (e.type.startsWith("bg_task_")) events.push([e.agent, e.type]); });
    cleanups.push(unsub);
    const old = { name: "agent-jwr2-bg-old", channelId: CH, cwd: join(root, "proj"), sessionId: "sid-r2-bg" };
    const main = projectJsonlPath(old.cwd, old.sessionId);
    mkdirSync(join(main, ".."), { recursive: true });
    writeFileSync(main, "Command running in background with ID: shr2\n");
    mkdirSync(join(root, "tasks"));
    let current = old;
    const poll = () => pollBgActivitiesForTest({ now: () => Date.now(), agents: async () => [current], shellDir: () => join(root, "tasks") });
    await poll();
    writeFileSync(join(root, "tasks", "shr2.output"), "running\n[exited with code 0]\n");
    const ticking = poll();
    await reached.promise;
    current = { ...old, name: "agent-jwr2-bg-new" };
    await syncWatcherOwners([{ ...current, status: "active" }]);
    gate.resolve();
    await ticking;
    await poll();
    const ended = (name: string) => activeBgTasksFor(name).map((t) => [t.id, (t.end as { exitCode?: unknown } | undefined)?.exitCode]);
    expect([ended(current.name), ended(old.name)]).toEqual([[["shr2", 0]], []]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter(([agent]) => agent !== current.name)).toEqual([]);
    const disk = new ShellResults();
    await disk.load(old.name, old.sessionId);
    expect(disk.snapshots(old.name)).toEqual([]);
  });
});

describe("[验收线 2] 已结束结果的改名迁移按频道 × 会话串行：A→B 未完时 B→C，最终都在 C", () => {
  test("select(A) 闸口暂停 A→B，期间同步 B 与 C，放行后再同步 C：C 有结果，B 为空", async () => {
    const results = new ShellResults();
    const owners = new ShellResultOwners(results);
    const ref = (name: string) => ({ name, channelId: "local-jwatch-r2-chain", sessionId: "sid-r2-chain" });
    const [A, B, C] = ["agent-jwr2-chain-a", "agent-jwr2-chain-b", "agent-jwr2-chain-c"];
    await results.select(A, "sid-r2-chain");
    await results.remember({ agentName: A, sessionId: "sid-r2-chain", id: "chain-task", startedAt: 1, lastGrowth: 2, exitCode: 0 }, 5, "done");
    await owners.sync([ref(A)]);
    const realSelect = results.select.bind(results);
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const sel = spyOn(results, "select").mockImplementation(async (agent: string, session: string) => {
      if (agent === A) { reached.resolve(); await gate.promise; }
      return realSelect(agent, session);
    });
    cleanups.push(() => sel.mockRestore());
    const ab = owners.sync([ref(B)]);
    await reached.promise;
    const bb = owners.sync([ref(B)]);
    const bc = owners.sync([ref(C)]);
    gate.resolve();
    await Promise.all([ab, bb, bc]);
    await owners.sync([ref(C)]);
    const ids = (n: string) => results.snapshots(n).map((s) => s.id);
    expect({ B: ids(B), C: ids(C) }).toEqual({ B: [], C: ["chain-task"] });
  });
});
