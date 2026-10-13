/**
 * hardening-JWATCH1 第 1 轮审查补测：停下后同一条目里 await 回来不再发旧会话的事；安装在途时 rescan 改名，
 * 装完归新名、按新名停得掉；已结束 bg shell 的结果（内存 + 落盘）随可信改名迁到新名。
 * 临时目录里的合成会话文件 + local- 频道 + 测试状态目录（tests/preload.ts），不碰 Discord / tmux。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeBgTasksFor, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher.ts";
import { WATCHER_CONFIG } from "../src/bridge/config.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import { agentNameForChannel, startWatching, stopWatching, stopWatchingByChannel } from "../src/bridge/jsonl-watcher.ts";
import { syncWatcherOwners } from "../src/bridge/watcher-ownership.ts";
import { ShellResults } from "../src/lib/bg-shell-results.ts";
import { projectJsonlPath } from "../src/lib/jsonl-cost.ts";
import * as cursorMod from "../src/lib/jsonl-read-cursor.ts";
import * as sessionPaths from "../src/lib/session-path-resolve.ts";

const discord = {} as Parameters<typeof startWatching>[4];
const settle = () => Bun.sleep(WATCHER_CONFIG.pollMs * 3);
const realTail = cursorMod.tailReadCursor;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture(channel: string) {
  const dir = mkdtempSync(join(tmpdir(), "jwatch-rename-"));
  const file = (sid: string) => join(dir, `${sid}.jsonl`);
  const resolve = spyOn(sessionPaths, "resolveSessionPath").mockImplementation((_rt, _cwd, sid) => {
    try { appendFileSync(file(sid), ""); } catch { /* 目录已清 */ }
    return file(sid);
  });
  const polls = new Set<unknown>();
  const si = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const h = realSetInterval(fn, ms, ...rest);
    if (ms === WATCHER_CONFIG.pollMs) polls.add(h);
    return h;
  }) as typeof setInterval);
  const ci = spyOn(globalThis, "clearInterval").mockImplementation(((h: Parameters<typeof clearInterval>[0]) => {
    polls.delete(h);
    return realClearInterval(h);
  }) as typeof clearInterval);
  const events: Array<{ type: string; agent: string; data: Record<string, unknown> }> = [];
  const hooks: Array<(e: { type: string }) => void> = [];
  const unsub = subscribeEvents({ allow: (e) => e.chatId === channel }, (e) => {
    events.push({ type: e.type, agent: e.agent, data: e.data as Record<string, unknown> });
    for (const h of hooks) h(e);
  });
  let tailSpy: { mockRestore(): void } | null = null;
  const hold = (sid: string) => {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    tailSpy = spyOn(cursorMod, "tailReadCursor").mockImplementation(async (p: string) => {
      if (p !== file(sid)) return realTail(p);
      reached.resolve();
      await gate.promise;
      return realTail(p);
    });
    return { reached: reached.promise, release: () => gate.resolve() };
  };
  cleanups.push(() => {
    stopWatchingByChannel(channel);
    unsub();
    tailSpy?.mockRestore();
    resolve.mockRestore();
    si.mockRestore();
    ci.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, polls, events, hooks, hold, texts: (t: string) => events.filter((e) => e.type === "assistant_text" && e.data.text === t) };
}

describe("[验收线 1] 停下落在条目内部的 await 上：回来后不再发旧会话的正文 / 事件", () => {
  test("api_error_turn 事件之后、正文之前按频道停：旧会话的 assistant_text 不再发", async () => {
    const CH = "local-jwatch-stale-entry", AG = "agent-jwatch-stale-entry";
    const f = fixture(CH);
    await startWatching(AG, f.dir, "sid-stale", CH, discord);
    let stopped = false;
    f.hooks.push((e) => { if (e.type === "api_error_turn") queueMicrotask(() => { stopped = stopWatchingByChannel(CH); }); });
    appendFileSync(f.file("sid-stale"), JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "overloaded", timestamp: new Date().toISOString(),
      message: { content: [{ type: "text", text: "stale-after-stop" }] } }) + "\n");
    await settle();
    expect(stopped).toBe(true);
    expect(f.events.filter((e) => e.type === "api_error_turn")).toHaveLength(1);
    expect(f.texts("stale-after-stop")).toEqual([]);
    expect([f.polls.size, agentNameForChannel(CH)]).toEqual([0, null]);
  });
});

describe("[验收线 2] 安装在 stat/数行 await 期间被 rescan 改名：装完归新名，按新名停得掉", () => {
  test("rescan 改挂在途安装：恢复后 map / 标签即新名，一条消息一次", async () => {
    const CH = "local-jwatch-rename-inflight";
    const f = fixture(CH);
    const h = f.hold("sid-i");
    const pending = startWatching("agent-jwi-old", f.dir, "sid-i", CH, discord);
    await h.reached;
    await syncWatcherOwners([{ name: "agent-jwi-new", channelId: CH, sessionId: "sid-i", status: "active" }]);
    h.release();
    await pending;
    expect(agentNameForChannel(CH)).toBe("agent-jwi-new");
    expect(f.polls.size).toBe(1);
    appendFileSync(f.file("sid-i"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "inflight-renamed" }] } }) + "\n");
    await settle();
    expect(f.texts("inflight-renamed").map((e) => e.agent)).toEqual(["agent-jwi-new"]);
    stopWatching("agent-jwi-new");
    expect([f.polls.size, agentNameForChannel(CH)]).toEqual([0, null]);
  });

  test("改名后按新名停：在途安装回来放弃，0 资源", async () => {
    const CH = "local-jwatch-rename-inflight-stop";
    const f = fixture(CH);
    const h = f.hold("sid-j");
    const pending = startWatching("agent-jwj-old", f.dir, "sid-j", CH, discord);
    await h.reached;
    await syncWatcherOwners([{ name: "agent-jwj-new", channelId: CH, sessionId: "sid-j", status: "active" }]);
    stopWatching("agent-jwj-new");
    h.release();
    await pending;
    expect([f.polls.size, agentNameForChannel(CH)]).toEqual([0, null]);
  });

  test("会话对不上的登记不改挂在途安装（不迁到猜测名）", async () => {
    const CH = "local-jwatch-rename-inflight-other";
    const f = fixture(CH);
    const h = f.hold("sid-k");
    const pending = startWatching("agent-jwk", f.dir, "sid-k", CH, discord);
    await h.reached;
    await syncWatcherOwners([{ name: "agent-jwk-guess", channelId: CH, sessionId: "another", status: "active" }]);
    h.release();
    await pending;
    expect(agentNameForChannel(CH)).toBe("agent-jwk");
  });

  test("同名换频道再登记：旧频道在途的安装回来放弃，不盖掉新频道那套", async () => {
    const A = "local-jwatch-move-a", B = "local-jwatch-move-b", AG = "agent-jwatch-move";
    const f = fixture(A);
    cleanups.push(() => stopWatchingByChannel(B));
    const h = f.hold("sid-a");
    const pending = startWatching(AG, f.dir, "sid-a", A, discord);
    await h.reached;
    await startWatching(AG, f.dir, "sid-b", B, discord);
    h.release();
    await pending;
    expect([agentNameForChannel(A), agentNameForChannel(B)]).toEqual([null, AG]);
  });
});

describe("[验收线 2] 已结束 bg shell 的结果随可信改名迁到新名（内存快照 + 落盘归属）", () => {
  test("rescan 后与下一轮 poll 后：新名有 exit 0 的结果，旧名为空；新进程按新名能读回", async () => {
    const root = mkdtempSync(join(tmpdir(), "jwatch-bg-res-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const old = { name: "agent-jwres-old", channelId: "local-jwatch-res", cwd: join(root, "proj"), sessionId: "sid-res" };
    const main = projectJsonlPath(old.cwd, old.sessionId);
    mkdirSync(join(main, ".."), { recursive: true });
    writeFileSync(main, "Command running in background with ID: shjw1\n");
    mkdirSync(join(root, "tasks"));
    let clock = 1_900_000_000_000;
    const poll = (a: typeof old) => pollBgActivitiesForTest({ now: () => clock, agents: async () => [a], shellDir: () => join(root, "tasks") });
    await poll(old);
    writeFileSync(join(root, "tasks", "shjw1.output"), "running\n");
    await poll(old);
    appendFileSync(join(root, "tasks", "shjw1.output"), "[exited with code 0]\n");
    clock += 10_000;
    await poll(old);
    const ended = (name: string) => activeBgTasksFor(name).map((t) => [t.id, (t.end as { exitCode?: unknown } | undefined)?.exitCode]);
    expect(ended(old.name)).toEqual([["shjw1", 0]]);
    const renamed = { ...old, name: "agent-jwres-new" };
    await syncWatcherOwners([{ ...renamed, status: "active" }]);
    expect([ended(renamed.name), ended(old.name)]).toEqual([[["shjw1", 0]], []]);
    await poll(renamed);
    expect([ended(renamed.name), ended(old.name)]).toEqual([[["shjw1", 0]], []]);
    const disk = new ShellResults();
    await disk.load(renamed.name, renamed.sessionId);
    expect(disk.snapshots(renamed.name).map((s) => [s.id, s.end.exitCode])).toEqual([["shjw1", 0]]);
  });
});
