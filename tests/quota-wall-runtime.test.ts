/**
 * bridge/quota-wall.ts（依赖全假）+ held-queue 的额度闸部分：多个 agent 撞墙只进一次闸、只通知一次；闸内 agent / bridge
 * 消息押住、人类消息与 Codex 目标照投；临时 429 不进闸；重启恢复；出闸三个来源；恢复顺序（关菜单 → 按序补投 → 续跑）、
 * 已在跑的不续、画面对不上的不发键；恢复途中重启从当前那步接着做、不重复发 Esc。
 */
import { describe, expect, test } from "bun:test";
import { ageHeld, HeldQueue, HELD_GIVE_UP_MS } from "../src/bridge/held-queue.js";
import { createQuotaWall, type QuotaWallDeps, type WallWindow } from "../src/bridge/quota-wall.js";
import type { Envelope } from "../src/bridge/router.js";
import { emptyWallState, type WallState } from "../src/lib/quota-wall.js";

const T0 = Date.parse("2026-09-28T13:19:40Z");
const WEEKLY = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const MENU = [
  " What do you want to do?",
  " ❯ 1. Stop and wait for limit to reset",
  "   2. Wait here, then continue automatically at Sep 30 at 6am",
  "   3. Switch to usage credits",
  " Enter to confirm · Esc to cancel",
].join("\n");

function env(from: Envelope["from"], to: string, id: string): Envelope {
  const meta = { messageId: id, triggerKind: "agent_tool" as const, ts: "", threadId: "" };
  return { from, to: { kind: "local", channelId: to, agentName: `agent-${to}`, ws: {} as never }, intent: "request", content: id, meta };
}
const agentFrom = (cid: string): Envelope["from"] => ({ kind: "local", agentName: `agent-${cid}`, channelId: cid, ws: {} as never });

function rig(opts: { disk?: WallState; panes?: Record<string, string>; busy?: string[]; codex?: string[] } = {}) {
  let now = T0;
  let disk: WallState = opts.disk ?? emptyWallState();
  const held = new HeldQueue(null);
  const panes: Record<string, string> = { ...opts.panes };
  const log: string[] = [];
  const esc: string[] = [];
  const flushed: string[] = [];
  const resumed: { cid: string; text: string }[] = [];
  const notices: string[] = [];
  const clear = { req: false };
  const probe = { v: null as { pct: number | null; observedAt: number } | null, calls: 0 };
  const windows: WallWindow[] = ["a", "b", "c", "pm"].map((c) => ({ channelId: c, agent: `agent-${c}`, win: `master:agent-${c}` }));
  const deps: QuotaWallDeps = {
    now: () => now,
    newId: () => "wall_1",
    load: () => structuredClone(disk),
    save: (s) => void (disk = structuredClone(s)),
    isClaudeCode: async (cid) => !(opts.codex ?? []).includes(cid),
    windows: async () => windows,
    capture: async (win) => panes[win] ?? "",
    sendEsc: async (win) => void esc.push(win),
    mainTurnBusy: async (cid) => (opts.busy ?? []).includes(cid),
    held: {
      wallCount: () => held.wallCount(),
      queuedFor: (cid) => !!held.get(cid)?.length,
      wallChannels: () => held.wallChannels(),
      release: (t) => held.releaseWall(t),
    },
    flush: async (cid) => {
      flushed.push(cid);
      held.delete(cid);
    },
    resume: async (cid, _agent, text) => (resumed.push({ cid, text }), true),
    notifyOwner: async (text) => (notices.push(text), true),
    probe: async () => (probe.calls++, probe.v),
    credits: async () => 1,
    readCache: () => null,
    takeClearRequest: () => (clear.req ? ((clear.req = false), true) : false),
    sleep: async () => {},
    log: (m) => void log.push(m),
  };
  return {
    wall: createQuotaWall(deps), deps, held, panes, esc, flushed, resumed, notices, clear, probe, log,
    disk: () => disk, advance: (ms: number) => void (now += ms), at: () => now,
  };
}

const hitWall = (r: ReturnType<typeof rig>, cid: string, dt = 0) =>
  r.wall.noteApiError({ channelId: cid, agent: `agent-${cid}`, at: T0 + dt, error: "rate_limit", text: WEEKLY });

describe("进闸 / 押后", () => {
  test("多个 agent 陆续撞墙：一道闸、只通知一次（等 20 秒把同一波并进来）", async () => {
    const r = rig();
    for (const [i, c] of ["a", "b", "pm"].entries()) expect(await hitWall(r, c, i * 1000)).toBe(true);
    expect(r.wall.active()).toBe(true);
    await r.wall.tick();
    expect(r.notices).toHaveLength(0);
    r.advance(25_000);
    await r.wall.tick();
    r.advance(15_000);
    await r.wall.tick();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("agent-pm");
    expect(r.wall.until()).toBe(Date.parse("2026-09-29T21:00:00Z"));
  });

  test("临时 429 不进闸（走原来的 60 秒续跑）；Codex 撞墙不进闸", async () => {
    const r = rig({ codex: ["cx"] });
    expect(await r.wall.noteApiError({ channelId: "a", agent: "agent-a", at: T0, error: "rate_limit", text: "API Error: 429 This request would exceed your account's rate limit." })).toBe(false);
    expect(await r.wall.noteApiError({ channelId: "cx", agent: "agent-cx", at: T0, error: "rate_limit", text: WEEKLY })).toBe(false);
    expect(r.wall.active()).toBe(false);
  });

  test("闸内：agent / bridge / peer 消息押住，人类消息、Codex 目标照投；闸内别的 API 错误交给闸", async () => {
    const r = rig({ codex: ["cx"] });
    expect(await r.wall.holds(env(agentFrom("b"), "a", "m0"), "a")).toBe(false); // 没闸
    await hitWall(r, "a");
    expect(await r.wall.holds(env(agentFrom("b"), "a", "m1"), "a")).toBe(true);
    expect(await r.wall.holds(env({ kind: "bridge", label: "mission" }, "a", "m2"), "a")).toBe(true);
    expect(await r.wall.holds(env({ kind: "api", name: "sekai", tokenId: "t", peer: "sekai" } as never, "a", "m3"), "a")).toBe(true);
    expect(await r.wall.holds(env({ kind: "user", userId: "u", username: "owner" } as never, "a", "m4"), "a")).toBe(false);
    expect(await r.wall.holds(env({ kind: "api", name: "web", tokenId: "t" } as never, "a", "m5"), "a")).toBe(false);
    expect(await r.wall.holds(env(agentFrom("b"), "cx", "m6"), "cx")).toBe(false);
    expect(await r.wall.noteApiError({ channelId: "c", agent: "agent-c", at: T0 + 5, error: "server_error", text: "API Error: 500" })).toBe(true);
    expect(Object.keys(r.wall.snapshot().wall!.hits)).toEqual(["a", "c"]);
  });

  test("bridge 重启后闸状态不丢", async () => {
    const r = rig();
    await hitWall(r, "a");
    const again = rig({ disk: r.disk() });
    expect(again.wall.active()).toBe(true);
    expect(again.wall.until()).toBe(r.wall.until());
    expect(Object.keys(again.wall.snapshot().wall!.hits)).toEqual(["a"]);
  });
});

describe("出闸三个来源", () => {
  test("「Limits reset」回显：进闸时画面上已有的旧回显不算，新出现的才算", async () => {
    const old = "  ⎿  Limits reset · your weekly reset day stays Wed · 1 resets left\n";
    const r = rig({ panes: { "master:agent-b": old } });
    await hitWall(r, "a");
    await r.wall.tick(); // 取基线
    expect(r.wall.active()).toBe(true);
    r.panes["master:agent-b"] = old + "\n> /limit-reset\n" + old;
    r.advance(15_000);
    await r.wall.tick();
    expect(r.wall.active()).toBe(false);
    expect(r.disk().wall!.exit!.via).toBe("limits_reset");
  });

  test("用量探测：5 分钟一次，看到 <100 出闸", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.probe.v = { pct: 100, observedAt: T0 + 60_000 };
    r.advance(60_000);
    await r.wall.tick();
    expect(r.probe.calls).toBe(0);
    r.advance(5 * 60_000);
    await r.wall.tick();
    expect(r.probe.calls).toBe(1);
    expect(r.wall.active()).toBe(true);
    r.probe.v = { pct: 4, observedAt: r.at() + 5 * 60_000 };
    r.advance(5 * 60_000);
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("probe");
  });

  test("quota-wall clear 的请求 / 到了重置时间", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.clear.req = true;
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("cli");
    const r2 = rig();
    await hitWall(r2, "a");
    r2.advance(Date.parse("2026-09-29T21:01:00Z") - T0);
    await r2.wall.tick();
    expect(r2.disk().wall!.exit!.via).toBe("resets_at");
  });

  test("出闸回调（T14 据此重排唤醒）", async () => {
    const r = rig();
    const seen: string[] = [];
    r.wall.onExit((via) => seen.push(via));
    await hitWall(r, "a");
    expect(r.wall.clear()).toBe(true);
    expect(seen).toEqual(["cli"]);
  });
});

describe("恢复", () => {
  test("关菜单（只对认得的）→ 按最早入队顺序补投 → 续跑没消息、没在跑的；通知一次", async () => {
    const r = rig({ panes: { "master:agent-a": MENU, "master:agent-b": MENU, "master:agent-c": " What do you want to do?\n ❯ 1. Something new\n Enter to confirm · Esc to cancel" }, busy: ["c"] });
    for (const c of ["a", "b", "c", "pm"]) await hitWall(r, c);
    r.held.holdEnv(env(agentFrom("pm"), "b", "late"), "quota_wall");
    r.advance(1);
    r.held.holdEnv(env(agentFrom("a"), "pm", "early"), "quota_wall");
    r.held.set("pm", [{ ...r.held.get("pm")![0], heldAt: T0 - 10 }]); // 给 pm 的那条更早入队：补投先投 pm
    r.wall.clear();
    await r.wall.tick();
    expect(r.esc).toEqual(["master:agent-a", "master:agent-b"]);
    expect(r.flushed).toEqual(["pm", "b"]);
    // b、pm 有补投的消息，c 在跑：只续 a
    expect(r.resumed.map((x) => x.cid)).toEqual(["a"]);
    expect(r.resumed[0].text).toContain("额度");
    const rec = r.disk().wall!.recovery!;
    expect(rec).toMatchObject({ step: "done", flushed: 2, manual: ["agent-c"], running: ["agent-c"] });
    expect(r.notices.at(-1)).toContain("agent-c");
    await r.wall.tick();
    expect(r.resumed).toHaveLength(1);
    expect(r.esc).toHaveLength(2);
  });

  test("恢复途中重启：从记下的那一步接着做，已发过 Esc 的不再发", async () => {
    const r = rig({ panes: { "master:agent-a": MENU } });
    await hitWall(r, "a");
    r.wall.clear();
    const d = r.disk();
    d.wall!.recovery = { ...d.wall!.recovery!, step: "flush", escSent: ["a"] };
    const again = rig({ disk: d, panes: { "master:agent-a": MENU } });
    await again.wall.tick();
    expect(again.esc).toEqual([]);
    expect(again.resumed.map((x) => x.cid)).toEqual(["a"]);
    expect(again.disk().wall!.recovery!.step).toBe("done");
  });
});

describe("押后队列的额度闸部分", () => {
  const e = (id: string) => env(agentFrom("x"), "t", id);
  test("闸内押的不老化；闸前押的被再押一次改记成额度闸；出闸转回普通押后、入队时间重置", () => {
    const q = new HeldQueue(null);
    const before = e("before");
    q.holdEnv(before);
    q.holdEnv(e("wall"), "quota_wall");
    q.holdEnv(before, "quota_wall");
    expect(q.wallCount()).toBe(2);
    for (const i of q.get("t")!) i.heldAt = 0;
    expect(ageHeld(q, HELD_GIVE_UP_MS + 1)).toEqual([]);
    expect(q.releaseWall(123)).toBe(2);
    expect(q.get("t")!.map((i) => [i.reason, i.heldAt])).toEqual([[undefined, 123], [undefined, 123]]);
    expect(q.wallCount()).toBe(0);
  });
});
