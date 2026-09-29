/**
 * bridge/quota-wall.ts（依赖全假）+ held-queue 的额度闸部分：多个 agent 撞墙只进一次闸、只通知一次；闸内 agent / bridge
 * 消息押住、人类消息与 Codex 目标照投；临时 429 不进闸；重启恢复；出闸三个来源；恢复顺序（关菜单 → 按序补投 → 续跑）、
 * 已在跑的不续、画面对不上的不发键；恢复途中重启从当前那步接着做、不重复发 Esc。
 */
import { describe, expect, test } from "bun:test";
import { ageHeld, HeldQueue, HELD_GIVE_UP_MS } from "../src/bridge/held-queue.js";
import { createQuotaWall, type QuotaWallDeps, type WallWindow } from "../src/bridge/quota-wall.js";
import type { Envelope } from "../src/bridge/router.js";
import { senderTrigger } from "../src/bridge/stop-settle.js";
import { emptyWallState, type UsageSignal, type WallState } from "../src/lib/quota-wall.js";

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

interface RigOpts { disk?: WallState; panes?: Record<string, string>; busy?: string[]; codex?: string[]; stuck?: string[]; heldResume?: string[]; lp?: string[]; deep?: Record<string, string> }
function rig(opts: RigOpts = {}) {
  let now = T0;
  let disk: WallState = opts.disk ?? emptyWallState();
  const held = new HeldQueue(null);
  const panes: Record<string, string> = { ...opts.panes };
  const log: string[] = [];
  const esc: string[] = [];
  const prepared: string[] = [];
  const cache = { v: null as UsageSignal | null };
  const flushed: string[] = [];
  const resumed: { cid: string; text: string; afterTurn?: boolean }[] = [];
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
    lowPriority: async (cid) => (opts.lp ?? []).includes(cid),
    windows: async () => windows,
    capture: async (win, history = 30) => (history > 30 && opts.deep?.[win]) || panes[win] || "", // deep = 往上翻得到的整段历史
    prepare: async (win) => void prepared.push(win),
    sendEsc: async (win) => {
      esc.push(win);
      if (!(opts.stuck ?? []).includes(win)) panes[win] = "❯ "; // 菜单收起；stuck = Esc 被吃掉、菜单还在
    },
    mainTurnBusy: async (cid) => (opts.busy ?? []).includes(cid),
    held: {
      wallCount: () => held.wallCount(),
      queuedFor: (cid) => !!held.get(cid)?.length,
      wallChannels: () => held.wallChannels(),
      wakers: () => held.wallChannels((i) => senderTrigger(i.env.from) !== "stranger"),
      release: (t) => held.releaseWall(t),
    },
    flush: async (cid) => {
      flushed.push(cid);
      held.delete(cid);
    },
    resume: async (cid, _agent, text, afterTurn) => ((opts.heldResume ?? []).includes(cid) ? "held" : (resumed.push({ cid, text, afterTurn }), true)),
    notifyOwner: async (text) => (notices.push(text), true),
    probe: async () => (probe.calls++, probe.v),
    credits: async () => 1,
    readCache: () => cache.v,
    takeClearRequest: () => (clear.req ? ((clear.req = false), true) : false),
    sleep: async () => {},
    log: (m) => void log.push(m),
  };
  return {
    wall: createQuotaWall(deps), deps, held, panes, esc, prepared, cache, flushed, resumed, notices, clear, probe, log,
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
    // 服务端临时限流（本机 36 条实录，error 同样是 rate_limit）、单个模型的额度：都不闸整台机器
    const limiting = "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(await r.wall.noteApiError({ channelId: "a", agent: "agent-a", at: T0, error: "rate_limit", text: limiting })).toBe(false);
    const fable = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    expect(await r.wall.noteApiError({ channelId: "a", agent: "agent-a", at: T0, error: "rate_limit", text: fable })).toBe(false);
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

  test("开了 low-priority 照常在跑的窗口：闸对它放行，agent 消息照投、不算在闸里（T24 wf gate-state-2）", async () => {
    const r = rig({ lp: ["lp"] });
    await hitWall(r, "a");
    expect(await r.wall.holds(env(agentFrom("b"), "lp", "m1"), "lp")).toBe(false);
    expect(await r.wall.gates("lp")).toBe(false);
    expect(await r.wall.gates("a")).toBe(true);
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
  test("「Limits reset」回显：进闸时画面上已有的旧回显不算（窗口变高露出来的同一条也不算），新出现的才算", async () => {
    const old = "❯ /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 2 resets left\n";
    const r = rig({ panes: { "master:agent-b": old } });
    await hitWall(r, "a");
    await r.wall.tick(); // 取基线
    expect(r.wall.active()).toBe(true);
    r.panes["master:agent-b"] = `${old}\n${old}`; // 抓屏范围变大，同一条旧回显多露出一次
    r.advance(15_000);
    await r.wall.tick();
    expect(r.wall.active()).toBe(true);
    r.panes["master:agent-b"] = `${old}\n❯ /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 1 resets left\n`;
    r.advance(15_000);
    await r.wall.tick();
    expect(r.wall.active()).toBe(false);
    expect(r.disk().wall!.exit!.via).toBe("limits_reset");
  });

  test("闸内重启：基线按 2000 行重取、这一拍不判；之后窗口变高露出的旧回显不算，新回显照算（T24 wf2 gate-state-1）", async () => {
    const old = "❯ /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 2 resets left\n";
    const first = rig();
    await hitWall(first, "a");
    await first.wall.tick();
    // 重启：同一份落盘状态，进程内基线没了；旧回显在 30 行之外，只有往上翻 2000 行才看得到
    const r = rig({ disk: first.disk(), panes: { "master:agent-b": "❯ " }, deep: { "master:agent-b": `${old}\n❯ ` } });
    r.advance(15_000);
    await r.wall.tick();
    expect(r.wall.active()).toBe(true);
    r.panes["master:agent-b"] = `${old}\n❯ `; // owner 挂上来窗口变高，旧回显露出来
    r.advance(15_000);
    await r.wall.tick();
    expect(r.wall.active()).toBe(true);
    r.panes["master:agent-b"] = `${old}\n❯ /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 1 resets left\n`;
    r.advance(15_000);
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("limits_reset");
  });

  test("进闸那一刻就取基线：进闸后、第一拍之前出现的回显也算", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.panes["master:agent-b"] = "> /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 1 resets left\n";
    await r.wall.tick();
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

  test("续跑消息被押住（窗口还停在 CC 的自动续跑倒计时上）：不算续跑过，出闸通知单列、请人去窗口里处理（T24 wf delivery-hold-6 / -10）", async () => {
    const r = rig({ heldResume: ["b"] });
    for (const c of ["a", "b"]) await hitWall(r, c);
    r.wall.clear();
    await r.wall.tick();
    expect(r.resumed.map((x) => x.cid)).toEqual(["a"]);
    expect(r.disk().wall!.recovery).toMatchObject({ resumed: ["agent-a"], held: ["agent-b"] });
    expect(r.notices.at(-1)).toContain("续跑 1 个 agent");
    expect(r.notices.at(-1)).toContain("自动续跑倒计时");
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

describe("恢复的边角（T24 r1 P2-1/2/3/7/9）", () => {
  test("先退出 copy-mode 再抓屏发键；发了 Esc 菜单还在（被吃掉）就不算关了，列进通知", async () => {
    const r = rig({ panes: { "master:agent-a": MENU, "master:agent-b": MENU }, stuck: ["master:agent-b"] });
    await hitWall(r, "a");
    r.wall.clear();
    await r.wall.tick();
    expect(r.prepared).toEqual(["master:agent-a", "master:agent-b"]); // 只对要发 Esc 的窗口退出 copy-mode（r2 P2-7）
    expect(r.esc).toEqual(["master:agent-a", "master:agent-b"]); // 只发一次，不重试
    expect(r.disk().wall!.recovery).toMatchObject({ escSent: ["a", "b"], escFailed: ["agent-b"] });
    expect(r.notices.at(-1)).toContain("关菜单 1 个窗口");
    expect(r.notices.at(-1)).toContain("发了 Esc 菜单还开着");
  });

  test("关菜单途中又撞墙：旧恢复停下，不把进度写到新闸上、不补投新闸押的消息、不发「已恢复」", async () => {
    const r = rig({ panes: { "master:agent-a": MENU, "master:agent-b": MENU } });
    await hitWall(r, "a");
    r.wall.clear();
    const send = r.deps.sendEsc;
    let once = false;
    r.deps.sendEsc = async (win) => {
      await send(win);
      if (!once) {
        once = true;
        r.deps.newId = () => "wall_2";
        await hitWall(r, "c", 60_000); // 假出闸后 CC 自己接着跑、马上又撞
      }
    };
    r.held.holdEnv(env(agentFrom("pm"), "b", "new-wall"), "quota_wall");
    await r.wall.tick();
    const w = r.disk().wall!;
    expect(w.id).toBe("wall_2");
    expect(w.exit).toBeUndefined();
    expect(w.recovery).toBeUndefined();
    expect(r.held.wallCount()).toEqual({ human: 0, agent: 1 });
    expect(r.flushed).toEqual([]);
    expect(r.notices.filter((n) => n.startsWith("✅"))).toEqual([]);
  });

  test("补投了却还押着（它停在撞墙等待画面、被判成忙）：照样续跑，不当成「消息会叫醒它」", async () => {
    const r = rig();
    await hitWall(r, "a");
    await hitWall(r, "b");
    r.held.holdEnv(env(agentFrom("pm"), "a", "to-a"), "quota_wall");
    r.held.holdEnv(env(agentFrom("pm"), "b", "to-b"), "quota_wall");
    r.deps.flush = async (cid) => {
      r.flushed.push(cid);
      if (cid === "a") r.held.delete(cid); // a 投出去了；b 被押回来
    };
    r.wall.clear();
    await r.wall.tick();
    expect(r.flushed.sort()).toEqual(["a", "b"]);
    expect(r.resumed.map((x) => x.cid)).toEqual(["b"]);
  });

  test("出闸补投的全是外人（guest / peer）的消息：照样续跑撞墙那一轮；补投了 owner / agent 消息的才算会叫醒它（wf3 delivery-hold-2）", async () => {
    const r = rig();
    for (const c of ["a", "b", "c", "pm"]) await hitWall(r, c);
    r.held.holdEnv(env({ kind: "api", tokenId: "tok-g", name: "guest" }, "a", "guest-a"), "quota_wall");
    r.held.holdEnv(env({ kind: "api", tokenId: "tok-p", name: "sekai", peer: "sekai" }, "b", "peer-b"), "quota_wall");
    r.held.holdEnv(env({ kind: "api", tokenId: "tok-o", name: "owner", owner: true }, "c", "owner-c"), "quota_wall");
    r.held.holdEnv(env(agentFrom("a"), "pm", "a-pm"), "quota_wall");
    r.wall.clear();
    await r.wall.tick();
    expect(r.flushed.sort()).toEqual(["a", "b", "c", "pm"]);
    expect(r.resumed.map((x) => x.cid).sort()).toEqual(["a", "b"]);
    expect(r.disk().wall!.recovery!.wakers!.sort()).toEqual(["c", "pm"]);
  });

  test("补投的外人消息一送到就开了一轮（判成在跑）：续跑押到那一轮后面照发；没补投过、在跑的才算自己续上了（沙箱 e2e 复现）", async () => {
    const r = rig({ busy: ["a", "d"] });
    for (const c of ["a", "d"]) await hitWall(r, c);
    r.held.holdEnv(env({ kind: "api", tokenId: "tok-g", name: "guest" }, "a", "guest-a"), "quota_wall");
    r.wall.clear();
    await r.wall.tick();
    expect(r.resumed.map((x) => [x.cid, x.afterTurn])).toEqual([["a", true]]);
    expect(r.disk().wall!.recovery).toMatchObject({ resumed: ["agent-a"], running: ["agent-d"] });
  });

  test("noteActivity 交出从续跑名单拿掉的那条（外人那一轮不算数时 rearmResume 放回去）", async () => {
    const r = rig();
    await hitWall(r, "a");
    expect(r.wall.noteActivity("a", T0 + 1)).toBeNull(); // 错误条目自己带出的活动（宽限内）不算
    expect(r.wall.noteActivity("a", T0 + 10_000)).toMatchObject({ agent: "agent-a", error: "rate_limit" });
    expect(r.wall.noteActivity("a", T0 + 20_000)).toBeNull();
  });

  test("补投记账之后、flush 之前重启：条数不重记成 0", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.held.holdEnv(env(agentFrom("pm"), "b", "q"), "quota_wall");
    r.wall.clear();
    const d = r.disk();
    d.wall!.recovery = { ...d.wall!.recovery!, step: "flush", flushed: 1, flushedTo: ["b"] };
    const again = rig({ disk: d });
    await again.wall.tick();
    expect(again.disk().wall!.recovery).toMatchObject({ step: "done", flushed: 1 });
    expect(again.notices.at(-1)).toContain("补投 1 条");
  });

  test("原文没写重置时间：按闸里看到的缓存重置时刻到点出闸；缓存也没有就按 session 5 小时兜底", async () => {
    const r = rig();
    await r.wall.noteApiError({ channelId: "a", agent: "agent-a", at: T0, error: "rate_limit", text: "You've hit your session limit" });
    r.cache.v = { sessionPct: 100, weekPct: 40, sessionResetsAtMs: T0 + 3_600_000, weekResetsAtMs: T0 + 9e7, scrapedAt: T0 + 30_000 };
    r.advance(30_000);
    await r.wall.tick();
    expect(r.wall.until()).toBe(T0 + 3_600_000);
    r.advance(3_600_000 + 60_000); // 重置时刻 + 1 分钟余量
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("resets_at");
    const r2 = rig();
    await r2.wall.noteApiError({ channelId: "a", agent: "agent-a", at: T0, error: "rate_limit", text: "You've hit your usage limit" });
    expect(r2.wall.until()).toBe(T0 + 5 * 3_600_000);
  });

  test("用卡出闸后缓存还是撞墙时的 100%（周重置日不变）：不会刚出又进", async () => {
    const r = rig();
    await hitWall(r, "a");
    const full = { sessionPct: 30, weekPct: 100, sessionResetsAtMs: T0 + 3_600_000, weekResetsAtMs: T0 + 9e7, scrapedAt: T0 + 20_000 };
    r.cache.v = full;
    r.advance(20_000);
    await r.wall.tick();
    r.panes["master:agent-b"] = "❯ /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 1 resets left\n";
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("limits_reset");
    const entered = r.notices.filter((n) => n.startsWith("⛔")).length;
    r.cache.v = { ...full, scrapedAt: r.at() + 60_000 }; // 补投的消息一到，状态栏重渲染又把 100% 写回来
    r.advance(90_000);
    await r.wall.tick();
    await r.wall.tick();
    expect(r.wall.active()).toBe(false);
    expect(r.notices.filter((n) => n.startsWith("⛔"))).toHaveLength(entered);
  });
});

describe("恢复做到一半重启（T24 wf2 gate-state-2）", () => {
  test("续跑那一步：押着续跑消息的、出闸时在跑的都算处理过，重启后不再续跑、名单不重复", async () => {
    const first = rig({ heldResume: ["a"] });
    for (const c of ["a", "b", "c"]) await hitWall(first, c);
    first.clear.req = true;
    await first.wall.tick();
    const w = first.disk().wall!;
    expect(w.recovery).toMatchObject({ step: "done", held: ["agent-a"], resumed: ["agent-b", "agent-c"] });
    // 回到「续跑做了一半」：a 押着、b 出闸时在跑、c 还没轮到
    const disk = { v: 1 as const, wall: { ...w, recoveredNotifiedAt: undefined, recovery: { ...w.recovery!, step: "resume" as const, resumed: [], running: ["agent-b"] } } };
    const r = rig({ disk });
    await r.wall.tick();
    expect(r.resumed.map((x) => x.cid)).toEqual(["c"]);
    expect(r.disk().wall!.recovery).toMatchObject({ held: ["agent-a"], running: ["agent-b"], resumed: ["agent-c"] });
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
    expect(q.wallCount()).toEqual({ human: 0, agent: 2 });
    expect(q.wallCount((x) => x.meta.messageId === "wall")).toEqual({ human: 1, agent: 1 }); // 人发的和 agent 消息分开数（横幅、进闸通知分开写）
    for (const i of q.get("t")!) i.heldAt = 0;
    expect(ageHeld(q, HELD_GIVE_UP_MS + 1)).toEqual([]);
    expect(q.releaseWall(123)).toBe(2);
    expect(q.get("t")!.map((i) => [i.reason, i.heldAt])).toEqual([[undefined, 123], [undefined, 123]]);
    expect(q.wallCount()).toEqual({ human: 0, agent: 0 });
  });
});
