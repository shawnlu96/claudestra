/**
 * bridge/codex-wall.ts（依赖全假）+ 真的 HeldQueue：进墙（⛔ / 用量满）→ 押 agent 消息、人发的照投、CC 频道不管；
 * 出墙三个来源（用量回落 / 兑卡后立刻复查 / clear）；恢复顺序（补投 → 续跑 → 收卡 → 告诉 caller → 告诉 owner）与幂等；
 * bridge 重启（重新 load 盘上状态）后墙还在、恢复从当前那步接着做、不重复补投 / 续跑。
 */
import { describe, expect, test } from "bun:test";
import { createCodexWall, type CodexWallDeps } from "../src/bridge/codex-wall.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import type { Envelope } from "../src/bridge/router.js";
import { senderTrigger } from "../src/bridge/stop-settle.js";
import { CODEX_WALL_TIMING, emptyCodexWallState, type CodexUsageSignal, type CodexWallState } from "../src/lib/codex-wall.js";

const T0 = Date.parse("2026-09-30T01:48:00Z");
const HIT = "You've hit your usage limit. Upgrade to Pro, visit settings to purchase more credits or try again at Oct 3rd, 2026 9:12 AM.";
const R = "codex_quota_wall" as const;

function env(from: Envelope["from"], cid: string, id: string): Envelope {
  const to = { kind: "local" as const, channelId: cid, agentName: `agent-${cid}`, ws: {} as never };
  return { from, to, intent: "request", content: id, meta: { messageId: id, triggerKind: "agent_tool", ts: "", threadId: "" } };
}
const agentFrom = (cid: string): Envelope["from"] => ({ kind: "local", agentName: `agent-${cid}`, channelId: cid, ws: {} as never });
const owner: Envelope["from"] = { kind: "user", userId: "u1", username: "owner" } as Envelope["from"];

interface RigOpts { disk?: CodexWallState; held?: HeldQueue; busy?: string[]; failOwner?: boolean }
function rig(opts: RigOpts = {}) {
  let now = T0;
  let disk: CodexWallState = opts.disk ?? emptyCodexWallState();
  const held = opts.held ?? new HeldQueue(null);
  const view = { v: null as CodexUsageSignal | null, fresh: null as CodexUsageSignal | null, refreshes: 0 };
  const calls: string[] = [];
  const clear = { req: false };
  const owner = { fail: !!opts.failOwner, texts: [] as string[] };
  const deps: CodexWallDeps = {
    now: () => now,
    newId: () => "cx_1",
    load: () => structuredClone(disk),
    save: (s) => void (disk = structuredClone(s)),
    isCodex: async (cid) => cid !== "cc",
    usage: async (refresh) => {
      if (refresh) {
        view.refreshes++;
        if (view.fresh) view.v = { ...view.fresh, observedAt: now };
      }
      return view.v;
    },
    held: {
      count: () => held.wallCount(() => false, R).agent,
      channels: () => held.wallChannels(undefined, R),
      wakers: () => held.wallChannels((i) => senderTrigger(i.env.from) !== "stranger", R),
      queuedFor: (cid) => !!held.get(cid)?.some((i) => senderTrigger(i.env.from) !== "stranger"),
      release: (t) => held.releaseWall(t, R),
    },
    flush: async (cid) => {
      calls.push(`flush:${cid}`);
      held.delete(cid);
    },
    mainTurnBusy: async (cid) => (opts.busy ?? []).includes(cid),
    resume: async (cid, _a, text) => (calls.push(`resume:${cid}`), expect(text).toContain("Codex 额度已恢复，继续你被打断的任务；先核对做到哪一步再动手"), true),
    dismissCards: async () => (calls.push("cards"), 2),
    tellCaller: async (cid, text) => (calls.push(`tell:${cid}:${text.match(/\] (.+?) 的 Codex/)?.[1]}`), true),
    notifyOwner: async (text) => (owner.texts.push(text), calls.push("owner"), !owner.fail),
    takeClearRequest: () => (clear.req ? ((clear.req = false), true) : false),
    log: () => {},
  };
  const make = () => createCodexWall(deps);
  return { wall: make(), restart: make, held, view, calls, clear, owner, disk: () => disk, advance: (ms: number) => void (now += ms), at: () => now };
}

type Rig = ReturnType<typeof rig>;
const hitWall = (r: Rig, cid: string, callers: string[] = []) => r.wall.noteHit({ channelId: cid, agent: `agent-${cid}`, at: r.at(), text: HIT, callers });
const usage = (p: Partial<CodexUsageSignal> = {}): CodexUsageSignal => ({ account: "acct", usedPct: 100, limitReached: true, observedAt: T0, credits: 2, ...p });
/** 模拟 deliverToLocal 的押后判断（bridge.ts 用 wallHoldOf：CC 闸先问、再问这道墙） */
async function send(r: Rig, e: Envelope): Promise<"held" | "sent"> {
  const cid = (e.to as { channelId: string }).channelId;
  if (await r.wall.holds(e, cid)) return (r.held.holdEnv(e, R), "held");
  return "sent";
}

describe("进墙 / 押后", () => {
  test("⛔ 进墙：发给 Codex 的 agent / bridge 消息押住，人发的照投，CC 频道不管", async () => {
    const r = rig();
    r.view.v = usage({ usedPct: 60, limitReached: false, observedAt: T0 - 1 }); // 视图里是撞墙前的旧值
    expect(await hitWall(r, "a", ["pm"])).toBe(true);
    expect(r.wall.active()).toBe(true);
    expect(r.disk().wall!.account).toBe("acct");
    expect(await send(r, env(agentFrom("pm"), "a", "m1"))).toBe("held");
    expect(await send(r, env({ kind: "bridge", label: "ledger" }, "b", "m2"))).toBe("held");
    expect(await send(r, env(owner, "a", "m3"))).toBe("sent");
    expect(await send(r, env(agentFrom("pm"), "cc", "m4"))).toBe("sent");
    expect(r.wall.snapshot().queued).toBe(2);
    expect(await r.wall.gates("a")).toBe(true);
    expect(await r.wall.gates("cc")).toBe(false);
    await r.wall.tick(); // 旧观测不放墙
    expect(r.wall.active()).toBe(true);
  });

  test("单个模型的额度不进墙", async () => {
    const r = rig();
    expect(await r.wall.noteHit({ channelId: "a", agent: "agent-a", at: T0, text: "You've reached your gpt-5 limit.", callers: [] })).toBe(false);
    expect(r.wall.active()).toBe(false);
  });

  test("用量满（看板在刷的视图）也进墙", async () => {
    const r = rig();
    r.view.v = usage({ observedAt: T0 });
    await r.wall.tick();
    expect(r.wall.active()).toBe(true);
    expect(r.disk().wall!.source).toBe("usage");
    expect(await send(r, env(agentFrom("pm"), "a", "m1"))).toBe("held");
  });

  test("重启后墙还在、照样押", async () => {
    const r = rig();
    await hitWall(r, "a");
    const again = r.restart();
    expect(again.active()).toBe(true);
    expect(await again.holds(env(agentFrom("pm"), "a", "m1"), "a")).toBe(true);
  });
});

describe("认恢复", () => {
  test("墙里每 5 分钟探一次；用量回落 → 出墙并恢复", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.view.fresh = usage();
    r.advance(CODEX_WALL_TIMING.probeEveryMs - 1000);
    await r.wall.tick();
    expect(r.view.refreshes).toBe(0);
    r.advance(1000);
    await r.wall.tick();
    expect(r.view.refreshes).toBe(1);
    expect(r.wall.active()).toBe(true); // 还满
    r.view.fresh = usage({ usedPct: 12, limitReached: false });
    r.advance(CODEX_WALL_TIMING.probeEveryMs);
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("usage");
    expect(r.disk().wall!.recovery!.step).toBe("done");
  });

  test("兑卡：视图里重置卡变少 → 不等 5 分钟，马上复查", async () => {
    const r = rig();
    r.view.v = usage({ observedAt: T0 - 5 });
    await hitWall(r, "a");
    await r.wall.tick();
    expect(r.disk().wall!.credits).toBe(2);
    r.view.v = { ...r.view.v!, credits: 1 }; // 看板 / 6 小时明细刷到了：卡少了一张
    r.view.fresh = usage({ usedPct: 0, limitReached: false, credits: 1 });
    r.advance(30_000);
    await r.wall.tick();
    expect(r.view.refreshes).toBe(1);
    expect(r.disk().wall!.exit!.via).toBe("usage");
  });

  test("clear：人手确认恢复", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.clear.req = true;
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("cli");
    expect(r.wall.clear()).toBe(false); // 已经出墙
  });

  test("换了 Codex 账号 → 出墙", async () => {
    const r = rig();
    r.view.v = usage({ observedAt: T0 - 5 });
    await hitWall(r, "a");
    r.view.v = usage({ account: "other", observedAt: T0 + 10 });
    r.advance(15_000);
    await r.wall.tick();
    expect(r.disk().wall!.exit!.via).toBe("account");
  });

  test("探测不可用：到 try-again 时刻复查一次，探不到就按时间放行", async () => {
    const r = rig();
    await hitWall(r, "a");
    const w = r.disk().wall!;
    r.advance(w.resetsAt! + CODEX_WALL_TIMING.exitSlackMs - T0);
    await r.wall.tick();
    expect(r.view.refreshes).toBe(1);
    expect(r.disk().wall!.resetProbed).toBe(true);
    expect(r.disk().wall!.exit!.via).toBe("resets_at");
  });
});

describe("恢复动作", () => {
  test("顺序：补投 → 续跑（被补投叫醒的不续、在跑的不续）→ 收卡 → 告诉 caller → 告诉 owner", async () => {
    const r = rig({ busy: ["c"] });
    await hitWall(r, "a", ["pm"]);
    await hitWall(r, "b", ["pm", "qa"]);
    await hitWall(r, "c");
    await send(r, env(agentFrom("pm"), "b", "m1")); // b 有自己人的消息押着：补投会叫醒它
    r.clear.req = true;
    await r.wall.tick();
    expect(r.calls).toEqual(["flush:b", "resume:a", "cards", "tell:pm:agent-a、agent-b", "tell:qa:agent-b", "owner"]);
    const rec = r.disk().wall!.recovery!;
    expect(rec).toMatchObject({ step: "done", flushed: 1, resumed: ["agent-a"], running: ["agent-c"], cards: 2, told: ["pm", "qa"] });
    expect(r.owner.texts[0]).toContain("Codex 额度已恢复（人工确认）");
    expect(r.held.wallCount(() => false, R).agent).toBe(0);
  });

  test("幂等：恢复做完后再 tick / 再 clear 不重复补投、续跑、通知", async () => {
    const r = rig();
    await hitWall(r, "a", ["pm"]);
    r.clear.req = true;
    await r.wall.tick();
    const n = r.calls.length;
    r.clear.req = true;
    r.advance(60_000);
    await r.wall.tick();
    await r.wall.tick();
    expect(r.calls.length).toBe(n);
  });

  test("owner 通知没发出去：下一拍只重发通知，前面的步骤不重做", async () => {
    const r = rig({ failOwner: true });
    await hitWall(r, "a", ["pm"]);
    r.clear.req = true;
    await r.wall.tick();
    expect(r.disk().wall!.recovery!.step).toBe("owner");
    r.owner.fail = false;
    await r.wall.tick();
    expect(r.calls).toEqual(["resume:a", "cards", "tell:pm:agent-a", "owner", "owner"]);
    expect(r.disk().wall!.recovery!.step).toBe("done");
  });

  test("恢复做到一半重启：从当前那步接着做，已续跑的不再续", async () => {
    const r = rig();
    await hitWall(r, "a");
    await hitWall(r, "b");
    r.clear.req = true;
    await r.wall.tick();
    const disk = structuredClone(r.disk());
    disk.wall!.recovery = { ...disk.wall!.recovery!, step: "resume", resumed: ["agent-a"], told: [] };
    const r2 = rig({ disk });
    await r2.wall.tick();
    expect(r2.calls).toEqual(["resume:b", "cards", "owner"]);
  });

  test("没有墙却押着墙消息（状态文件丢了）：放回普通押后并补投", async () => {
    const held = new HeldQueue(null);
    held.holdEnv(env(agentFrom("pm"), "a", "m1"), R);
    const r = rig({ held });
    await r.wall.tick();
    expect(r.calls).toEqual(["flush:a"]);
  });

  test("恢复做完后又撞：开新墙，旧墙恢复记录不影响新墙押消息", async () => {
    const r = rig();
    await hitWall(r, "a");
    r.clear.req = true;
    await r.wall.tick();
    r.advance(60_000);
    expect(await hitWall(r, "b")).toBe(true);
    expect(r.wall.active()).toBe(true);
    expect(Object.keys(r.disk().wall!.hits)).toEqual(["b"]);
    expect(await send(r, env(agentFrom("pm"), "a", "m9"))).toBe("held");
  });
});
