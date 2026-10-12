/**
 * hardening-CRONRUN1: `manager remove <name> --lifecycle-guard <json>` with a session-only guard (cron's temp agents: no card links
 * them, so the plan re-check can never pass). Real runRemove over the in-memory world (tests/resumable-world.ts); the flag is
 * parsed from argv as manager.ts does. Nothing touches tmux, Discord, the bridge or the state dir.
 */
import { describe, expect, test } from "bun:test";
import { LIFECYCLE_GUARD_FLAG, sessionGuardArgs } from "../src/lib/agent-lifecycle-run.js";
import { newPending } from "../src/lib/pending-ops.js";
import { runRemove } from "../src/manager/agent-kill.js";
import { lifecycleRemoveOption, type LifecycleRemoveFacts } from "../src/manager/agent-remove-guard.js";
import type { AgentInfo } from "../src/manager/core.js";
import { makeWorld } from "./resumable-world.js";

const NAME = "agent-cron-nightly-abc";
const entry = (sessionId: string, more: Partial<AgentInfo> = {}): AgentInfo =>
  ({ project: "p", purpose: "cron: nightly", created: "c", status: "active", channelId: `ch-${sessionId}`, notes: "", sessionId, cwd: "/nowhere", ...more });

function scene(info: AgentInfo = entry("S1")) {
  const w = makeWorld({ reg: { socket: "s", agents: { [NAME]: info } }, windows: [NAME], channels: new Set([info.channelId!]) });
  const calls: string[] = [];
  let held = false;
  const facts: LifecycleRemoveFacts = {
    lock: () => { if (held || w.st.restarting.includes(NAME)) return null; held = true; calls.push("lock"); return () => { held = false; calls.push("unlock"); }; },
    replan: async () => { calls.push("replan"); throw new Error("只核会话的守卫不该读生命周期计划"); },
    commit: async (mutate) => {
      const reg = await w.deps.loadRegistry();
      const why = mutate(reg);
      if (!why) await w.deps.saveRegistry(reg);
      return why;
    },
    dropSettings: () => { calls.push("dropSettings"); },
  };
  /** argv after `remove <name>` → what manager.ts hands runRemove, with the fake facts in place of the production ones */
  const remove = (args: string[]) => {
    const opt = lifecycleRemoveOption(args).lifecycle;
    if (!opt) throw new Error("没解析出守卫");
    return runRemove(NAME, w.deps, { lifecycle: { guard: opt.guard, facts } });
  };
  return { w, calls, remove };
}

describe("只核会话的 --lifecycle-guard", () => {
  test("会话一致：关原窗口、归档、删频道、删条目；不读生命周期计划", async () => {
    const s = scene();
    expect(sessionGuardArgs("S1")).toEqual([LIFECYCLE_GUARD_FLAG, '{"sessionOnly":true,"sessionId":"S1"}']);
    const r = await s.remove(sessionGuardArgs("S1"));
    expect(r).toMatchObject({ ok: true, agent: NAME, sessionOnly: true });
    expect([s.w.st.windows, Object.keys(s.w.st.reg.agents), [...s.w.st.channels], s.w.st.archived]).toEqual([[], [], [], [NAME]]);
    expect(s.calls).toEqual(["lock", "dropSettings", "unlock"]);
    // 已经不在：和不带守卫的 remove 一样说「不存在」（cron 当作已自清）
    expect(await s.remove(sessionGuardArgs("S1"))).toEqual({ ok: false, agent: NAME, error: `${NAME} 不存在` });
  });

  test("会话已变：拒，不关窗、不归档、不删频道、条目原样，带回现在的会话", async () => {
    const s = scene(entry("S2"));
    const before = structuredClone(s.w.st.reg);
    const r = await s.remove(sessionGuardArgs("S1"));
    expect(r).toMatchObject({ ok: false, refused: true, seenSession: "S2" });
    expect(String(r.error)).toContain("现在的会话 S2 不是预期的 S1");
    expect([s.w.st.windows, s.w.st.reg, [...s.w.st.channels], s.w.st.archived]).toEqual([[NAME], before, ["ch-S2"], []]);
    expect(s.w.trace).toEqual([]);
    expect(s.calls).toEqual(["lock", "unlock"]);
  });

  test("重核期间换了会话：核对和移除不拆开，不关窗", async () => {
    const s = scene();
    const load = s.w.deps.loadRegistry;
    let reads = 0;
    s.w.deps.loadRegistry = async () => { const reg = await load(); if (++reads === 2) { s.w.st.reg.agents[NAME].sessionId = "S2"; reg.agents[NAME].sessionId = "S2"; } return reg; };
    const r = await s.remove(sessionGuardArgs("S1"));
    expect(r).toMatchObject({ ok: false, refused: true });
    expect([s.w.st.windows, s.w.st.reg.agents[NAME].sessionId, s.w.st.archived]).toEqual([[NAME], "S2", []]);
  });

  test("缺 sessionId / 字段不是 true / 守卫是坏 JSON：一律拒，不退回按名字移除", async () => {
    for (const raw of ['{"sessionOnly":true}', '{"sessionOnly":true,"sessionId":""}', '{"sessionOnly":true,"sessionId":null}', '{"sessionOnly":false,"sessionId":"S1"}',
      '{"sessionOnly":"yes","sessionId":"S1"}', "{", ""]) {
      const s = scene();
      const r = await s.remove([LIFECYCLE_GUARD_FLAG, raw]);
      expect([raw, r.ok, r.refused, "seenSession" in r]).toEqual([raw, false, true, false]);
      expect([s.w.st.windows, Object.keys(s.w.st.reg.agents), s.w.trace]).toEqual([[NAME], [NAME], []]);
    }
    // 直接给对象（不经 argv）也一样
    const s = scene();
    const direct = await runRemove(NAME, s.w.deps, { lifecycle: { guard: { sessionOnly: true, sessionId: "" }, facts: lifecycleFacts(s) } });
    expect([direct.refused, s.w.st.windows]).toEqual([true, [NAME]]);
  });

  test("条目上有操作在跑 / restart 锁被占 / 条目没了却有同名窗口：拒，不关窗；可重试的拒绝不带 seenSession", async () => {
    const busy = scene(entry("S1", { pending: newPending("create", { channelName: "c" }, Date.parse("2026-09-28T12:00:00Z")) }));
    const r1 = await busy.remove(sessionGuardArgs("S1"));
    expect([r1.refused, "seenSession" in r1, busy.w.st.windows]).toEqual([true, false, [NAME]]);

    const locked = scene();
    locked.w.st.restarting.push(NAME);
    const r2 = await locked.remove(sessionGuardArgs("S1"));
    expect([r2.refused, "seenSession" in r2, locked.w.st.windows]).toEqual([true, false, [NAME]]);

    const orphan = scene();
    delete orphan.w.st.reg.agents[NAME];
    const r3 = await orphan.remove(sessionGuardArgs("S1"));
    expect([r3.refused, orphan.w.st.windows]).toEqual([true, [NAME]]);
  });

  test("不带 sessionOnly 字段的守卫照旧走计划重核", async () => {
    const s = scene();
    const policy = { mode: "on" };
    const r = await s.remove([LIFECYCLE_GUARD_FLAG, JSON.stringify({ sessionId: "S1", taskId: null, role: "stock", rule: "stock", activeAt: null, policy })]);
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(s.calls).toEqual(["lock", "replan", "unlock"]);
    expect(s.w.st.windows).toEqual([NAME]);
  });
});

/** a facts object for a guard passed as an object: the scene's own, reached through one parsed call */
function lifecycleFacts(s: ReturnType<typeof scene>): LifecycleRemoveFacts {
  return { lock: () => () => {}, replan: async () => { throw new Error("不该读计划"); }, commit: async () => "不写", dropSettings: () => { s.calls.push("dropSettings"); } };
}
