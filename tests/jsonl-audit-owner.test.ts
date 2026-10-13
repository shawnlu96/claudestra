/**
 * hardening-JWATCH1：channel 观察器按「频道 × 安装代次」认归属。跨 stat/数行 await 回来已换代的旧调用不装资源；
 * rename 后同频道同会话只改挂名字（不重读尾、不丢正文），新名再登记不留旧名那一套；按频道停 = 该频道全 0。
 * 全部是临时目录里的合成会话文件 + local- 频道（不碰 Discord），轮询 / 等候句柄按创建 / 清除计数，泄漏的那套也数得到。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { activeBgTasksFor, hasActiveBgActivities, pollBgActivitiesForTest } from "../src/bridge/bg-activity-watcher.ts";
import { WATCHER_CONFIG } from "../src/bridge/config.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import {
  agentNameForChannel, drainChannelWatcher, pushEntries, startWatching, stopWatching, stopWatchingByChannel,
} from "../src/bridge/jsonl-watcher.ts";
import { projectJsonlPath, subagentsDir } from "../src/lib/jsonl-cost.ts";
import * as cursorMod from "../src/lib/jsonl-read-cursor.ts";
import * as sessionPaths from "../src/lib/session-path-resolve.ts";
import * as sessionSource from "../src/lib/session-source.ts";

const discord = {} as Parameters<typeof startWatching>[4];
const entry = (text: string) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text }] } });
const say = (text: string) => JSON.stringify(entry(text)) + "\n";
const settle = () => Bun.sleep(WATCHER_CONFIG.pollMs * 3);
// 本卡新模块：先红时旧代码里没有它，只让用到它的用例失败，不拖垮整个文件
const ownership = () => import("../src/bridge/watcher-ownership.ts");
const realTail = cursorMod.tailReadCursor;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const PENDING_POLL_MS = 2000;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function ownerFixture(channel: string) {
  const dir = mkdtempSync(join(tmpdir(), "jwatch-owner-"));
  const file = (sid: string) => join(dir, `${sid}.jsonl`);
  const hidden = new Set<string>();
  const resolve = spyOn(sessionPaths, "resolveSessionPath").mockImplementation((_rt, _cwd, sid) => {
    if (hidden.has(sid)) return null;
    try { appendFileSync(file(sid), ""); } catch { /* 测试目录已清掉：照样返回路径，由调用方的 stat 失败处理 */ }
    return file(sid);
  });
  const polls = new Set<unknown>();
  const pendings = new Set<unknown>();
  const si = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const h = realSetInterval(fn, ms, ...rest);
    if (ms === WATCHER_CONFIG.pollMs) polls.add(h);
    if (ms === PENDING_POLL_MS) pendings.add(h);
    return h;
  }) as typeof setInterval);
  const ci = spyOn(globalThis, "clearInterval").mockImplementation(((h: Parameters<typeof clearInterval>[0]) => {
    polls.delete(h);
    pendings.delete(h);
    return realClearInterval(h);
  }) as typeof clearInterval);
  const texts: Array<{ agent: string; text: string; sid: unknown }> = [];
  const unsub = subscribeEvents({ allow: (e) => e.chatId === channel }, (e) => {
    if (e.type !== "assistant_text") return;
    const d = e.data as { text?: unknown; sid?: unknown };
    texts.push({ agent: e.agent, text: String(d.text), sid: d.sid });
  });
  let tailSpy: { mockRestore(): void } | null = null;
  /** tailReadCursor 读到该会话文件时停在闸口：reached 后测试交错别的调用，release() 放行 */
  const hold = (sid: string, opts: { once?: boolean; fail?: Error; after?: () => void } = {}) => {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let used = false;
    tailSpy = spyOn(cursorMod, "tailReadCursor").mockImplementation(async (p: string) => {
      if (p !== file(sid) || (opts.once && used)) return realTail(p);
      used = true;
      reached.resolve();
      await gate.promise;
      if (opts.fail) throw opts.fail;
      const c = await realTail(p);
      opts.after?.();
      return c;
    });
    return { reached: reached.promise, release: () => gate.resolve() };
  };
  const f = {
    dir, file, hidden, polls, pendings, texts, hold,
    append: (sid: string, text: string) => appendFileSync(file(sid), say(text)),
    said: (text: string) => f.texts.filter((t) => t.text === text),
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
  return f;
}

/** 停下之后：轮询 / 等候句柄全清、频道无名、再写的正文没人发 */
async function expectAllStopped(f: ReturnType<typeof ownerFixture>, channel: string, sid: string) {
  expect(f.polls.size).toBe(0);
  expect(f.pendings.size).toBe(0);
  expect(agentNameForChannel(channel)).toBeNull();
  f.append(sid, `after-stop-${sid}`);
  await settle();
  expect(f.said(`after-stop-${sid}`)).toEqual([]);
}

describe("[验收线 1] 跨 stat/数行 await 的安装按频道代次认归属", () => {
  test("旧会话停在闸口 → 新会话登记完成 → 旧的恢复：只有新代一套，正文归新会话；按频道停后全 0", async () => {
    const CH = "local-jwatch-gen-rotate", AG = "agent-jwatch-gen-rotate";
    const f = ownerFixture(CH);
    const h = f.hold("sid-old");
    const older = startWatching(AG, f.dir, "sid-old", CH, discord);
    await h.reached;
    await startWatching(AG, f.dir, "sid-new", CH, discord);
    h.release();
    await older;
    expect(agentNameForChannel(CH)).toBe(AG);
    expect(f.polls.size).toBe(1);
    f.append("sid-old", "old-session-text");
    f.append("sid-new", "new-session-text");
    await settle();
    expect(f.said("old-session-text")).toEqual([]);
    expect(f.said("new-session-text")).toEqual([{ agent: AG, text: "new-session-text", sid: "sid-new" }]);
    expect(stopWatchingByChannel(CH)).toBe(true);
    await expectAllStopped(f, CH, "sid-new");
  });

  test("同一会话并发两次安装：只装一套，一条消息只发一次", async () => {
    const CH = "local-jwatch-gen-same", AG = "agent-jwatch-gen-same";
    const f = ownerFixture(CH);
    const h = f.hold("sid-same", { once: true });
    const first = startWatching(AG, f.dir, "sid-same", CH, discord);
    await h.reached;
    await startWatching(AG, f.dir, "sid-same", CH, discord);
    h.release();
    await first;
    expect(f.polls.size).toBe(1);
    f.append("sid-same", "same-once");
    await settle();
    expect(f.said("same-once")).toHaveLength(1);
    stopWatchingByChannel(CH);
    await expectAllStopped(f, CH, "sid-same");
  });
});

describe("[验收线 2] rename 后归属迁到新名，新名再登记不留旧名那一套", () => {
  test("socket 没彻底断开、新名直接再登记：同会话沿用并改挂新名，一条消息一次，按频道停后 0 资源", async () => {
    const CH = "local-jwatch-rename-reg";
    const f = ownerFixture(CH);
    await startWatching("agent-jw-old", f.dir, "sid-r", CH, discord);
    f.append("sid-r", "between-registrations"); // 两次登记之间写的行不能丢（不重读尾）
    await startWatching("agent-jw-new", f.dir, "sid-r", CH, discord);
    expect(agentNameForChannel(CH)).toBe("agent-jw-new");
    expect(f.polls.size).toBe(1);
    f.append("sid-r", "after-rename");
    await settle();
    expect(f.said("between-registrations").map((t) => t.agent)).toEqual(["agent-jw-new"]);
    expect(f.said("after-rename").map((t) => t.agent)).toEqual(["agent-jw-new"]);
    stopWatchingByChannel(CH);
    await expectAllStopped(f, CH, "sid-r");
  });

  test("rescan 按可信登记改挂：标签即新名、未发的正文不丢；新名再登记沿用这一套；之后搬路径照常跟", async () => {
    const { syncWatcherOwners } = await ownership();
    const CH = "local-jwatch-rename-rescan";
    const f = ownerFixture(CH);
    await startWatching("agent-jw-a", f.dir, "sid-s", CH, discord);
    f.append("sid-s", "unsent-before-rescan");
    const list = [{ name: "agent-jw-b", channelId: CH, sessionId: "sid-s", status: "active" }];
    expect(await syncWatcherOwners(list)).toBe(list);
    expect(agentNameForChannel(CH)).toBe("agent-jw-b");
    expect((await drainChannelWatcher(CH, discord)).text).toBe("unsent-before-rescan");
    expect(f.said("unsent-before-rescan").map((t) => t.agent)).toEqual(["agent-jw-b"]);
    await startWatching("agent-jw-b", f.dir, "sid-s", CH, discord);
    expect(f.polls.size).toBe(1);
    const moved = join(f.dir, "moved.jsonl");
    const find = spyOn(sessionSource, "findSessionJsonlBySessionId").mockReturnValue(moved);
    try {
      renameSync(f.file("sid-s"), moved);
      appendFileSync(moved, say("after-move"));
      await settle();
      expect(f.said("after-move").map((t) => t.agent)).toEqual(["agent-jw-b"]);
    } finally { find.mockRestore(); }
    stopWatchingByChannel(CH);
    expect(f.polls.size).toBe(0);
    expect(agentNameForChannel(CH)).toBeNull();
  });

  test("bg 活动缓存跟着改挂：快照 / 在跑判断按新名；会话对不上的不迁", async () => {
    const { syncWatcherOwners } = await ownership();
    const root = mkdtempSync(join(tmpdir(), "jwatch-bg-"));
    const oldHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    cleanups.push(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); });
    const ag = { name: "agent-jwbg-old", channelId: "local-jwatch-bg", cwd: join(root, "proj"), sessionId: "sid-bg" };
    mkdirSync(join(projectJsonlPath(ag.cwd, ag.sessionId), ".."), { recursive: true });
    writeFileSync(projectJsonlPath(ag.cwd, ag.sessionId), "");
    const subs = subagentsDir(ag.cwd, ag.sessionId);
    mkdirSync(subs, { recursive: true });
    let clock = 1_900_000_000_000;
    const poll = (a: typeof ag) => pollBgActivitiesForTest({ now: () => (clock += 1000), agents: async () => [a], shellDir: () => join(root, "tasks") });
    await poll(ag); // 首轮 baseline
    writeFileSync(join(subs, "agent-jwbg1.jsonl"), JSON.stringify({ type: "user", timestamp: new Date(clock).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "go" }] } }) + "\n");
    await poll(ag);
    expect(activeBgTasksFor("agent-jwbg-old").map((t) => t.id)).toEqual(["agent-jwbg1"]);
    await syncWatcherOwners([{ name: "agent-jwbg-new", channelId: ag.channelId, sessionId: "other-session", status: "active" }]);
    expect(hasActiveBgActivities("agent-jwbg-new")).toBe(false);
    await syncWatcherOwners([{ name: "agent-jwbg-new", channelId: ag.channelId, sessionId: ag.sessionId, status: "active" }]);
    expect(activeBgTasksFor("agent-jwbg-new").map((t) => t.id)).toEqual(["agent-jwbg1"]);
    expect(activeBgTasksFor("agent-jwbg-old")).toEqual([]);
    expect(hasActiveBgActivities("agent-jwbg-new")).toBe(true);
  });
});

describe("[验收线 3] 等文件出现 / 安装失败 / stop 与 await 交错不泄漏；推送收着的那份按频道沿用；无可信身份不迁", () => {
  test("stop 落在 stat/数行 await 期间：回来后不装，全 0（按频道停与按名字停都算）", async () => {
    for (const how of ["channel", "name"] as const) {
      const CH = `local-jwatch-stop-${how}`, AG = `agent-jwatch-stop-${how}`;
      const f = ownerFixture(CH);
      const h = f.hold("sid-x");
      const pending = startWatching(AG, f.dir, "sid-x", CH, discord);
      await h.reached;
      if (how === "channel") stopWatchingByChannel(CH);
      else stopWatching(AG);
      h.release();
      await pending;
      await expectAllStopped(f, CH, "sid-x");
    }
  }, 15_000);

  test("安装失败：数行抛错、或文件在 await 之后被删（fs.watch 抛）都不留句柄；之后照常能装", async () => {
    const CH = "local-jwatch-fail", AG = "agent-jwatch-fail";
    const f = ownerFixture(CH);
    const h1 = f.hold("sid-f", { once: true, fail: new Error("count failed") });
    const a = startWatching(AG, f.dir, "sid-f", CH, discord);
    await h1.reached;
    h1.release();
    expect(a).rejects.toThrow("count failed");
    await a.catch(() => undefined);
    expect([f.polls.size, agentNameForChannel(CH)]).toEqual([0, null]);
    const h2 = f.hold("sid-f", { once: true, after: () => rmSync(f.file("sid-f")) });
    const b = startWatching(AG, f.dir, "sid-f", CH, discord);
    await h2.reached;
    h2.release();
    await b.catch(() => undefined);
    expect([f.polls.size, agentNameForChannel(CH)]).toEqual([0, null]);
    await startWatching(AG, f.dir, "sid-f", CH, discord);
    f.append("sid-f", "works-after-failures");
    await settle();
    expect(f.said("works-after-failures")).toHaveLength(1);
    expect(f.polls.size).toBe(1);
  });

  test("等文件出现：等候期间归这个频道，新名登记换掉旧名的等候；文件出现后接上；按频道停全 0", async () => {
    const CH = "local-jwatch-pending";
    const f = ownerFixture(CH);
    f.hidden.add("sid-p");
    await startWatching("agent-jwp-old", f.dir, "sid-p", CH, discord);
    expect([f.pendings.size, agentNameForChannel(CH)]).toEqual([1, "agent-jwp-old"]);
    await startWatching("agent-jwp-new", f.dir, "sid-p", CH, discord);
    expect([f.pendings.size, agentNameForChannel(CH)]).toEqual([1, "agent-jwp-new"]);
    f.hidden.delete("sid-p");
    await Bun.sleep(PENDING_POLL_MS + 300);
    expect([f.pendings.size, f.polls.size, agentNameForChannel(CH)]).toEqual([0, 1, "agent-jwp-new"]);
    f.append("sid-p", "pending-then-live");
    await settle();
    expect(f.said("pending-then-live").map((t) => t.agent)).toEqual(["agent-jwp-new"]);
    stopWatchingByChannel(CH);
    await expectAllStopped(f, CH, "sid-p");
  }, 15_000);

  test("ACP 推送：断线收着的那份由新名同会话再登记沿用（正文不丢），按频道只留一份", async () => {
    const CH = "local-jwatch-acp";
    noteAcpChannel(CH, "acp");
    cleanups.push(() => { stopWatching("agent-jwacp-new"); stopWatching("agent-jwacp-old"); });
    await startWatching("agent-jwacp-old", "/w", "sid-acp", CH, discord, { transport: "acp" });
    expect(await pushEntries(CH, [entry("first-part")], discord)).toEqual({ ok: true, lost: 0 });
    stopWatchingByChannel(CH);
    await startWatching("agent-jwacp-new", "/w", "sid-acp", CH, discord, { transport: "acp" });
    expect(agentNameForChannel(CH)).toBe("agent-jwacp-new");
    expect(await pushEntries(CH, [entry("second-part")], discord)).toEqual({ ok: true, lost: 0 });
    expect((await drainChannelWatcher(CH, discord)).text).toBe("first-part\nsecond-part");
  });

  test("rescan 不迁到猜测名：缺会话 / 不在册 / 会话对不上的条目都不改挂", async () => {
    const { syncWatcherOwners } = await ownership();
    const CH = "local-jwatch-untrusted";
    const f = ownerFixture(CH);
    await startWatching("agent-jwu", f.dir, "sid-u", CH, discord);
    await syncWatcherOwners([
      { name: "agent-guess-1", channelId: CH },
      { name: "agent-guess-2", channelId: CH, sessionId: "sid-u", status: "stopped" },
      { name: "agent-guess-3", channelId: CH, sessionId: "another-session", status: "active" },
      { name: "agent-guess-4", sessionId: "sid-u", status: "active" },
    ]);
    expect(agentNameForChannel(CH)).toBe("agent-jwu");
    f.append("sid-u", "still-old-label");
    await settle();
    expect(f.said("still-old-label").map((t) => t.agent)).toEqual(["agent-jwu"]);
  });
});
