/**
 * lib/codex-wall.ts 的状态机 + held-queue 里两道闸的隔离：Codex 墙押的（codex_quota_wall）不老化、CC 闸的出闸补投 / 计数碰不到它，
 * 反过来也一样；held-flush 按 walled 返回的原因改记。CC 闸的默认行为（不传 reason）逐项钉住。
 */
import { describe, expect, test } from "bun:test";
import { flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { ageHeld, HeldQueue, HELD_GIVE_UP_MS } from "../src/bridge/held-queue.js";
import type { Envelope } from "../src/bridge/router.js";
import {
  callersToTell, codexExitVia, codexProbeDue, codexResumeTargets, codexWallActive, codexWallIdle, creditsDropped, CODEX_WALL_TIMING, emptyCodexWallState,
  enterFromUsage, isCodexAccountWall, isCodexWallState, markCodexExit, noteBelowAfterExit, noteCodexHit, type CodexUsageSignal, type CodexWallState,
} from "../src/lib/codex-wall.js";

const T0 = Date.parse("2026-09-30T01:48:00Z");
const HIT = "You've hit your usage limit. Upgrade to Pro, visit settings to purchase more credits or try again at Oct 3rd, 2026 9:12 AM.";
const id = () => "cx_1";
const usage = (p: Partial<CodexUsageSignal> = {}): CodexUsageSignal => ({ account: "acct", usedPct: 40, limitReached: false, observedAt: T0 + 1, credits: 2, ...p });
const hit = (s: CodexWallState, cid: string, at = T0, callers: string[] = []) =>
  noteCodexHit(s, { channelId: cid, agent: `agent-${cid}`, at, text: HIT, account: "acct", callers }, id);

describe("进墙", () => {
  test("⛔ 条目进墙：解析出 try-again 时刻；第二个 agent 并进同一道墙，caller 取并集、去掉自己", () => {
    const a = hit(emptyCodexWallState(), "a", T0, ["pm"]);
    expect(a.entered).toBe(true);
    expect(a.state.wall!.resetsAt).toBe(new Date(2026, 9, 3, 9, 12).getTime());
    expect(a.state.wall!.resetsText).toBe("at Oct 3rd, 2026 9:12 AM");
    const b = noteCodexHit(a.state, { channelId: "b", agent: "agent-b", at: T0 + 5, text: HIT, account: "acct", callers: ["pm", "b"] }, id);
    expect(b.entered).toBe(false);
    const again = noteCodexHit(b.state, { channelId: "a", agent: "agent-a", at: T0 + 9, text: HIT, account: "acct", callers: ["qa"] }, id);
    expect(Object.keys(again.state.wall!.hits)).toEqual(["a", "b"]);
    expect(again.state.wall!.hits.a.callers).toEqual(["pm", "qa"]);
    expect(again.state.wall!.hits.b.callers).toEqual(["pm"]);
  });

  test("单个模型的额度不算账号墙；认不出措辞的 ⛔ 按账号墙", () => {
    expect(isCodexAccountWall(HIT)).toBe(true);
    expect(isCodexAccountWall("You've reached your gpt-5 limit. Switch models to continue.")).toBe(false);
    expect(isCodexAccountWall("Quota exceeded for this workspace")).toBe(true);
  });

  test("用量满（≥100 或 limitReached）进墙；不满不进；墙在时不重进", () => {
    expect(enterFromUsage(emptyCodexWallState(), usage(), T0, id).entered).toBe(false);
    const byPct = enterFromUsage(emptyCodexWallState(), usage({ usedPct: 100 }), T0, id);
    expect(byPct.entered).toBe(true);
    expect(byPct.state.wall!.source).toBe("usage");
    expect(byPct.state.wall!.credits).toBe(2);
    expect(enterFromUsage(emptyCodexWallState(), usage({ usedPct: 80, limitReached: true }), T0, id).entered).toBe(true);
    expect(enterFromUsage(byPct.state, usage({ usedPct: 100 }), T0, id).entered).toBe(false);
  });

  test("人手 clear 出的墙：接口还显示满时不马上又进，先见过一次 <100 才从用量进", () => {
    const w = hit(emptyCodexWallState(), "a").state;
    let s = markCodexExit(w, "cli", T0 + 100);
    s.wall!.recovery!.step = "done";
    expect(enterFromUsage(s, usage({ usedPct: 100, observedAt: T0 + 200 }), T0 + 200, id).entered).toBe(false);
    expect(noteBelowAfterExit(s, usage({ observedAt: T0 + 50 }))).toBeNull(); // 出墙之前的观测不算
    s = noteBelowAfterExit(s, usage({ observedAt: T0 + 300 }))!;
    expect(s.wall!.belowAfterExit).toBe(true);
    expect(enterFromUsage(s, usage({ usedPct: 100, observedAt: T0 + 400 }), T0 + 400, id).entered).toBe(true);
  });

  test("用量回落出的墙：之后新的满观测直接进；比出墙早的观测不进", () => {
    let s = markCodexExit(hit(emptyCodexWallState(), "a").state, "usage", T0 + 100);
    s.wall!.recovery!.step = "done";
    expect(enterFromUsage(s, usage({ usedPct: 100, observedAt: T0 + 50 }), T0 + 200, id).entered).toBe(false);
    expect(enterFromUsage(s, usage({ usedPct: 100, observedAt: T0 + 150 }), T0 + 200, id).entered).toBe(true);
  });

  test("上一道恢复没做完又撞：名单里没续跑的带进新墙", () => {
    let s = hit(hit(emptyCodexWallState(), "a").state, "b", T0 + 1).state;
    s = markCodexExit(s, "usage", T0 + 100);
    s.wall!.recovery!.resumed = ["agent-a"];
    s.wall!.recovery!.step = "resume";
    const next = noteCodexHit(s, { channelId: "c", agent: "agent-c", at: T0 + 200, text: HIT, account: "acct", callers: [] }, () => "cx_2");
    expect(next.entered).toBe(true);
    expect(Object.keys(next.state.wall!.hits).sort()).toEqual(["b", "c"]);
  });
});

describe("出墙", () => {
  const wall = () => hit(emptyCodexWallState(), "a").state.wall!;
  test("用量回落（进墙之后的观测、<100、没 limitReached）", () => {
    const w = wall();
    expect(codexExitVia(w, { now: T0 + 10, usage: usage({ observedAt: T0 - 1 }) })).toBeNull(); // 撞墙之前的旧值
    expect(codexExitVia(w, { now: T0 + 10, usage: usage({ usedPct: 100 }) })).toBeNull();
    expect(codexExitVia(w, { now: T0 + 10, usage: usage({ usedPct: 30, limitReached: true }) })).toBeNull();
    expect(codexExitVia(w, { now: T0 + 10, usage: usage({ usedPct: null }) })).toBeNull();
    expect(codexExitVia(w, { now: T0 + 10, usage: usage() })).toBe("usage");
  });

  test("clear / 换号 / 探测不可用时到 try-again 兜底", () => {
    const w = wall();
    expect(codexExitVia(w, { now: T0, cli: true })).toBe("cli");
    expect(codexExitVia(w, { now: T0 + 10, usage: usage({ account: "other", usedPct: 100 }) })).toBe("account");
    const late = w.resetsAt! + CODEX_WALL_TIMING.exitSlackMs;
    expect(codexExitVia(w, { now: late, probeDown: false, usage: usage({ usedPct: 100, observedAt: late }) })).toBeNull(); // 探得到、还满：不放
    expect(codexExitVia(w, { now: late - 1, probeDown: true })).toBeNull();
    expect(codexExitVia(w, { now: late, probeDown: true })).toBe("resets_at");
  });

  test("兑卡：重置卡比墙里记的少了", () => {
    const w = { ...wall(), credits: 2 };
    expect(creditsDropped(w, 1)).toBe(true);
    expect(creditsDropped(w, 2)).toBe(false);
    expect(creditsDropped(w, null)).toBe(false);
    expect(creditsDropped({ ...w, credits: null }, 0)).toBe(false);
  });

  test("探测节奏：每 5 分钟；到 try-again 时刻额外一次；出墙后不探", () => {
    const w = wall();
    expect(codexProbeDue(w, T0 + CODEX_WALL_TIMING.probeEveryMs - 1)).toBe(false);
    expect(codexProbeDue(w, T0 + CODEX_WALL_TIMING.probeEveryMs)).toBe(true);
    const atReset = w.resetsAt! + CODEX_WALL_TIMING.exitSlackMs;
    expect(codexProbeDue({ ...w, lastProbeAt: atReset - 1000 }, atReset)).toBe(true);
    expect(codexProbeDue({ ...w, lastProbeAt: atReset - 1000, resetProbed: true }, atReset)).toBe(false);
    expect(codexProbeDue(markCodexExit({ v: 1, wall: w }, "cli", T0).wall!, T0 + 10 * 60_000)).toBe(false);
  });

  test("出墙只记一次；状态形状校验；active / idle", () => {
    const s: CodexWallState = { v: 1, wall: wall() };
    expect(codexWallActive(s)).toBe(true);
    const out = markCodexExit(s, "usage", T0 + 5);
    expect(markCodexExit(out, "cli", T0 + 9)).toBe(out);
    expect(codexWallActive(out)).toBe(false);
    expect(codexWallIdle(out)).toBe(false);
    expect(codexWallIdle({ v: 1, wall: { ...out.wall!, recovery: { ...out.wall!.recovery!, step: "done" } } })).toBe(true);
    expect(isCodexWallState(out)).toBe(true);
    expect(isCodexWallState({ v: 1, wall: { enteredAt: 1 } })).toBe(false);
    expect(isCodexWallState({ v: 2, wall: null })).toBe(false);
  });

  test("续跑名单与要告诉的 caller：处理过的、被补投叫醒的不再算", () => {
    let s = hit(hit(emptyCodexWallState(), "a", T0, ["pm"]).state, "b", T0 + 1, ["pm", "qa"]).state;
    s = markCodexExit(s, "usage", T0 + 9);
    expect(codexResumeTargets(s.wall!, () => false)).toEqual(["a", "b"]);
    expect(codexResumeTargets(s.wall!, (c) => c === "a")).toEqual(["b"]);
    s.wall!.recovery!.resumed = ["agent-b"];
    expect(codexResumeTargets(s.wall!, () => false)).toEqual(["a"]);
    expect([...callersToTell(s.wall!)]).toEqual([["pm", ["agent-a", "agent-b"]], ["qa", ["agent-b"]]]);
    s.wall!.recovery!.told = ["pm"];
    expect([...callersToTell(s.wall!)]).toEqual([["qa", ["agent-b"]]]);
  });
});

function env(from: Envelope["from"], to: string, msg: string): Envelope {
  return { from, to: { kind: "local", channelId: to, agentName: `agent-${to}`, ws: {} as never }, intent: "request", content: msg, meta: { messageId: msg, triggerKind: "agent_tool", ts: "", threadId: "" } };
}
const agentFrom = (cid: string): Envelope["from"] => ({ kind: "local", agentName: `agent-${cid}`, channelId: cid, ws: {} as never });

describe("押后队列：两道闸互不干扰（CC 闸默认行为不变）", () => {
  function twoWalls() {
    const q = new HeldQueue(null);
    q.holdEnv(env(agentFrom("pm"), "cc", "m1"), "quota_wall");
    q.holdEnv(env(agentFrom("pm"), "cx", "m2"), "codex_quota_wall");
    q.holdEnv(env(agentFrom("qa"), "cx", "m3"), "codex_quota_wall");
    return q;
  }
  test("不传 reason = CC 闸：计数 / 频道 / 出闸只动 quota_wall", () => {
    const q = twoWalls();
    expect(q.wallCount()).toEqual({ human: 0, agent: 1 });
    expect(q.wallChannels()).toEqual(["cc"]);
    expect(q.releaseWall(T0)).toBe(1);
    expect(q.get("cx")!.every((i) => i.reason === "codex_quota_wall")).toBe(true);
  });
  test("Codex 墙按自己的原因计数、出墙，不动 CC 的", () => {
    const q = twoWalls();
    expect(q.wallCount(() => false, "codex_quota_wall")).toEqual({ human: 0, agent: 2 });
    expect(q.wallChannels(undefined, "codex_quota_wall")).toEqual(["cx"]);
    expect(q.releaseWall(T0 + 5, "codex_quota_wall")).toBe(2);
    expect(q.get("cc")![0].reason).toBe("quota_wall");
    expect(q.get("cx")!.map((i) => [i.reason, i.heldAt])).toEqual([[undefined, T0 + 5], [undefined, T0 + 5]]);
  });
  test("两种墙押的都不老化（24 小时不放弃、不提醒）；普通押后照旧老化", () => {
    const q = twoWalls();
    q.holdEnv(env(agentFrom("pm"), "idle", "m4"));
    const out = ageHeld(q, Date.now() + HELD_GIVE_UP_MS + 1);
    expect(out.map((n) => n.item.env.meta.messageId)).toEqual(["m4"]);
    expect(q.get("cc")!.length + q.get("cx")!.length).toBe(3);
  });
  test("held-flush：walled 返回 true 按 CC 闸改记、返回 codex_quota_wall 按 Codex 墙改记，都不投", async () => {
    for (const [wall, reason] of [[true, "quota_wall"], ["codex_quota_wall", "codex_quota_wall"]] as const) {
      const q = new HeldQueue(null);
      q.holdEnv(env(agentFrom("pm"), "x", "m1"));
      const sent: string[] = [];
      const d: FlushDeps = {
        held: q, compacting: () => false, working: async () => false, isHumanRequest: () => false, walled: async () => wall,
        client: () => ({ ws: {} as never }), touch: () => {},
        deliver: async (e) => (sent.push(e.meta.messageId), { envelope: e, outcome: { kind: "sent" } }),
      };
      await flushHeld(d, "x", "test");
      expect(sent).toEqual([]);
      expect(q.get("x")![0].reason).toBe(reason);
    }
  });
});
