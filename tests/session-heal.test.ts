/**
 * Stop 自愈认出原生 /clear 轮转（CLR1）：hook 带的 session_id ≠ registry 时按 tmux 窗口确认后认领，
 * 不再被「旧文件 3 分钟内刚写过」的 mtime 快路径挡住；老 hook 不带 sid 时 mtime 兜底照旧。
 * 认领成功（含 clear 端点那条路）发 session_rotated，网页据此提示 + 重拉历史 + 刷 ctx。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { claimRotatedSession } from "../src/bridge/clear-rotation.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { maybeHealRotatedSession, type SessionHealDeps } from "../src/bridge/session-heal.js";
import type { RegistryAgent } from "../src/lib/registry.js";

const OLD = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW = "bbbbbbbb-0000-4000-8000-000000000002";
const CHILD = "cccccccc-0000-4000-8000-000000000003";
const now = Date.now();

const events: BridgeEvent[] = [];
const unsub = subscribeEvents({}, (e) => void (e.type === "session_rotated" && events.push(e)));
afterEach(() => void events.splice(0));
process.on("exit", unsub);

function harness(o: {
  channelId: string;
  agents?: RegistryAgent[];
  mtimes: Record<string, number>;
  windowSid?: string | null;
}) {
  const manager: string[][] = [];
  const rewatched: string[] = [];
  const mtimeCalls: string[] = [];
  const me: RegistryAgent = { name: `agent-${o.channelId}`, channelId: o.channelId, status: "active", cwd: "/w", sessionId: OLD };
  const deps: SessionHealDeps = {
    runManager: async (...args) => {
      manager.push(args);
      return { ok: true, previousSessionId: OLD };
    },
    rewatch: (_n, _c, sid) => void rewatched.push(sid),
    readAgents: async () => [me, ...(o.agents ?? [])],
    windowSession: async () => o.windowSid ?? null,
    listSessionIds: () => Object.keys(o.mtimes).sort((a, b) => o.mtimes[b] - o.mtimes[a]),
    mtimeOf: (p) => {
      const sid = basename(p, ".jsonl");
      mtimeCalls.push(sid);
      if (!(sid in o.mtimes)) throw new Error("ENOENT");
      return o.mtimes[sid];
    },
  };
  return { deps, manager, rewatched, mtimeCalls, me };
}

describe("Stop hook 带 session_id 的确定性判定", () => {
  test("复现 CLR1：hook sid ≠ registry、旧文件 1 分钟前刚写过 → 窗口确认后照样认领新会话", async () => {
    const h = harness({ channelId: "c1", mtimes: { [OLD]: now - 60_000, [NEW]: now - 1_000 }, windowSid: NEW });
    await maybeHealRotatedSession("c1", NEW, h.deps);
    expect(h.manager).toEqual([["set-session", "agent-c1", NEW]]);
    expect(h.rewatched).toEqual([NEW]);
    expect(events.map((e) => [e.agent, e.chatId, e.data])).toEqual([["agent-c1", "c1", { from: OLD, to: NEW }]]);
  });

  test("hook sid == registry → 什么都不动，也不再去 stat 文件猜", async () => {
    const h = harness({ channelId: "c2", mtimes: { [OLD]: now - 3_600_000, [NEW]: now - 1_000 }, windowSid: OLD });
    await maybeHealRotatedSession("c2", OLD, h.deps);
    expect(h.manager).toEqual([]);
    expect(h.mtimeCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("hook sid 是别的活 agent 的官方 session → 不认领", async () => {
    const other: RegistryAgent = { name: "agent-other", channelId: "x", status: "active", cwd: "/w", sessionId: NEW };
    const h = harness({ channelId: "c3", agents: [other], mtimes: { [OLD]: now - 60_000, [NEW]: now - 1_000 }, windowSid: NEW });
    await maybeHealRotatedSession("c3", NEW, h.deps);
    expect(h.manager).toEqual([]);
    expect(events).toEqual([]);
  });

  test("Bash 里嵌套的 claude -p 带着自己的 sid 打来 Stop：窗口登记仍是旧会话 → 不认领、落回 mtime（旧文件新鲜 → 不动）", async () => {
    const h = harness({ channelId: "c4", mtimes: { [OLD]: now - 5_000, [CHILD]: now - 1_000 }, windowSid: OLD });
    await maybeHealRotatedSession("c4", CHILD, h.deps);
    expect(h.manager).toEqual([]);
    expect(events).toEqual([]);
  });

  test("新旧两版 hook 并发打到（一个不带 sid、一个带）：带 sid 的不被 mtime 那次的去重挡掉", async () => {
    const h = harness({ channelId: "c7", mtimes: { [OLD]: now - 60_000, [NEW]: now - 1_000 }, windowSid: NEW });
    const read = h.deps.readAgents!;
    h.deps.readAgents = async () => (await Bun.sleep(30), read());
    await Promise.all([maybeHealRotatedSession("c7", undefined, h.deps), maybeHealRotatedSession("c7", NEW, h.deps)]);
    expect(h.manager).toEqual([["set-session", "agent-c7", NEW]]);
  });

  test("非法形状的 sid 当作没带", async () => {
    const h = harness({ channelId: "c5", mtimes: { [OLD]: now - 5_000, [NEW]: now - 1_000 }, windowSid: NEW });
    await maybeHealRotatedSession("c5", "../../etc/passwd", h.deps);
    expect(h.manager).toEqual([]);
  });

  test("非 CC 运行时不走窗口确认，落回 mtime", async () => {
    const h = harness({ channelId: "c6", mtimes: { [OLD]: now - 5_000, [NEW]: now - 1_000 }, windowSid: NEW });
    h.me.runtime = "pi";
    await maybeHealRotatedSession("c6", NEW, h.deps);
    expect(h.manager).toEqual([]);
  });
});

describe("老 hook 不带 session_id → 原 mtime 兜底", () => {
  test("旧文件陈旧、新文件本回合在写 → 认领", async () => {
    const h = harness({ channelId: "m1", mtimes: { [OLD]: now - 600_000, [NEW]: now - 1_000 } });
    await maybeHealRotatedSession("m1", undefined, h.deps);
    expect(h.manager).toEqual([["set-session", "agent-m1", NEW]]);
    expect(events.map((e) => e.data)).toEqual([{ from: OLD, to: NEW }]);
  });

  test("旧文件 3 分钟内写过 → 不动（CLR1 修前就是卡在这里）", async () => {
    const h = harness({ channelId: "m2", mtimes: { [OLD]: now - 60_000, [NEW]: now - 1_000 } });
    await maybeHealRotatedSession("m2", undefined, h.deps);
    expect(h.manager).toEqual([]);
  });

  test("最新候选属于别的活 agent → 不认领", async () => {
    const other: RegistryAgent = { name: "agent-other", channelId: "x", status: "active", cwd: "/w", sessionId: NEW };
    const h = harness({ channelId: "m3", agents: [other], mtimes: { [OLD]: now - 600_000, [NEW]: now - 1_000 } });
    await maybeHealRotatedSession("m3", undefined, h.deps);
    expect(h.manager).toEqual([]);
  });
});

describe("claimRotatedSession", () => {
  test("registry 已经是新会话（另一条路先认领了）→ 不重挂、不重复发事件", async () => {
    const rewatched: string[] = [];
    const r = await claimRotatedSession(
      { runManager: async () => ({ ok: true, previousSessionId: NEW }), rewatch: (_n, _c, sid) => void rewatched.push(sid) },
      { name: "agent-z", cwd: "/w", channelId: "z", runtime: undefined }, OLD, NEW,
    );
    expect(r.ok).toBe(true);
    expect(rewatched).toEqual([]);
    expect(events).toEqual([]);
  });

  test("set-session 失败 → 不重挂、不发事件，错误带回", async () => {
    const r = await claimRotatedSession(
      { runManager: async () => ({ ok: false, error: "boom" }), rewatch: () => { throw new Error("不该重挂"); } },
      { name: "agent-z", cwd: "/w", channelId: "z", runtime: undefined }, OLD, NEW,
    );
    expect(r).toEqual({ ok: false, error: "boom" });
    expect(events).toEqual([]);
  });
});
