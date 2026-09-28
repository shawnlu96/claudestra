import { beforeEach, describe, expect, test } from "bun:test";
import {
  compactInjectedRecently, ctxBoundaryTick, injectCompact, noteCompactInjected, resetCtxBoundaryState,
  type BoundaryAgent, type CtxBoundaryDeps,
} from "../src/bridge/ctx-boundary.js";
import { DEFAULT_KEEP_LIST, type PaneQuotaState } from "../src/lib/ctx-boundary-policy.js";

const MIN = 60_000;
const IDLE_PANE = "some output\n❯ \n";
const BUSY_PANE = "· Thinking… (esc to interrupt)\n❯ \n";

function harness(agents: BoundaryAgent[], opts: { panes?: Record<string, string | null>; state?: Partial<PaneQuotaState>; autoCompact?: any } = {}) {
  let now = 1_000_000_000;
  const sent: { target: string; line: string }[] = [];
  const logs: string[] = [];
  const state: PaneQuotaState = { wall: false, lp: "off", menu: false, compacting: false, ...opts.state };
  const deps: CtxBoundaryDeps = {
    now: () => now,
    agents: async () => agents,
    capture: async (t) => (opts.panes && t in opts.panes ? opts.panes[t] : IDLE_PANE),
    paneState: () => state,
    send: async (target, line) => void sent.push({ target, line }),
    autoCompact: () => opts.autoCompact,
    log: (l) => void logs.push(l),
  };
  return { deps, sent, logs, state, advance: (ms: number) => (now += ms), get now() { return now; } };
}

const agent = (o: Partial<BoundaryAgent>): BoundaryAgent => ({
  name: "agent-task-t1", projectId: "orch", target: "master:agent-task-t1", ctx: 0, convTs: 0, realWindow: null, ...o,
});

beforeEach(() => resetCtxBoundaryState());

describe("ctxBoundaryTick", () => {
  test("执行类：过 20 万且闲置满 3 分钟 → 注入 /compact <清单>；30 分钟内不重复；回落后冷却清零", async () => {
    const h = harness([]);
    const a = agent({ ctx: 210_000, convTs: h.now - 4 * MIN });
    h.deps.agents = async () => [a];
    const r1 = await ctxBoundaryTick(h.deps);
    expect(r1[0].verdict).toEqual({ fire: true, kind: "idle" });
    expect(h.sent).toEqual([{ target: a.target, line: `/compact ${DEFAULT_KEEP_LIST}` }]);
    expect(r1[0].inject?.status).toBe("executed");

    h.advance(16 * MIN); // 注入守卫（15 分钟）过了，但 30 分钟重试冷却还在
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "retry-wait" });
    expect(h.sent.length).toBe(1);

    a.ctx = 40_000; // 压下来了
    expect(await ctxBoundaryTick(h.deps)).toEqual([]);
    a.ctx = 205_000; // 很快又涨回来：冷却已清，不用等满 30 分钟
    a.convTs = h.now - 5 * MIN;
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: true, kind: "idle" });
    expect(h.sent.length).toBe(2);
  });

  test("闲置不到 3 分钟，或画面在忙 → 等", async () => {
    const h = harness([agent({ ctx: 210_000 })]);
    h.deps.agents = async () => [agent({ ctx: 210_000, convTs: h.now - 2 * MIN })];
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "busy" });
    const b = harness([], { panes: { "master:agent-task-t1": BUSY_PANE } });
    b.deps.agents = async () => [agent({ ctx: 210_000, convTs: b.now - 60 * MIN })];
    expect((await ctxBoundaryTick(b.deps))[0].verdict).toEqual({ fire: false, reason: "busy" });
    expect(h.sent.length + b.sent.length).toBe(0);
  });

  test("过 25 万硬上限：在忙也注入，结果是「已排队」", async () => {
    const h = harness([], { panes: { "master:agent-task-t1": BUSY_PANE } });
    h.deps.agents = async () => [agent({ ctx: 260_000, convTs: h.now })];
    const r = await ctxBoundaryTick(h.deps);
    expect(r[0].verdict).toEqual({ fire: true, kind: "hard-cap" });
    expect(r[0].inject?.status).toBe("queued");
    expect(h.sent.length).toBe(1);
  });

  test("撞墙没开 LP → 不注入，也不占重试计时：一开 LP 下一轮立刻注入", async () => {
    const h = harness([], { state: { wall: true, lp: "off" } });
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "quota-wall" });
    expect(h.sent.length).toBe(0);
    h.state.lp = "on";
    h.advance(MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: true, kind: "hard-cap" });
    expect(h.sent.length).toBe(1);
  });

  test("画面上有选择菜单 / 读不到画面 / 已有排队消息 → 不敲键", async () => {
    for (const [o, reason] of [
      [{ state: { menu: true } }, "menu"],
      [{ panes: { "master:agent-task-t1": null } }, "pane-unknown"],
      [{ panes: { "master:agent-task-t1": "❯ /compact x\n  Press up to edit queued messages\n" } }, "queued"],
    ] as const) {
      resetCtxBoundaryState();
      const h = harness([], o as any);
      h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
      expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason });
      expect(h.sent.length).toBe(0);
    }
  });

  test("手动按钮刚注入过 → 自动这边 15 分钟内不叠一条", async () => {
    const h = harness([]);
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
    noteCompactInjected("master:agent-task-t1", h.now - MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "compacting" });
  });

  test("没命中策略的个人 agent：走全局（线 / 闲置小时 / save-compact），行为不变", async () => {
    const h = harness([], { autoCompact: { window: 450_000, idleHours: 0.2 } });
    const car = agent({ name: "agent-car-talk", projectId: "personal", target: "master:agent-car-talk", ctx: 800_000, convTs: 0 });
    h.deps.agents = async () => [car, agent({ name: "agent-gc-car", projectId: "personal", target: "master:agent-gc-car", ctx: 400_000, convTs: 0 })];
    car.convTs = h.now - 10 * MIN; // 0.2 小时 = 12 分钟，还差 2 分钟
    const r = await ctxBoundaryTick(h.deps);
    expect(r.map((x) => [x.agent, x.boundary.policy, x.verdict])).toEqual([["agent-car-talk", "global", { fire: false, reason: "busy" }]]);
    h.advance(3 * MIN);
    await ctxBoundaryTick(h.deps);
    expect(h.sent).toEqual([{ target: "master:agent-car-talk", line: "/save-compact" }]);
  });

  test("协调者策略用 save-compact；读不到上下文的会话跳过；配置警告只打一次", async () => {
    const h = harness([], { autoCompact: { policies: [{ id: "executor", ccWindow: 50_000 }] } });
    h.deps.agents = async () => [
      agent({ name: "agent-pm-a", target: "master:agent-pm-a", ctx: 410_000, convTs: h.now }),
      agent({ name: "agent-task-x", target: "master:agent-task-x", ctx: null }),
    ];
    await ctxBoundaryTick(h.deps);
    await ctxBoundaryTick(h.deps);
    expect(h.sent).toEqual([{ target: "master:agent-pm-a", line: "/save-compact" }]);
    expect(h.logs.filter((l) => l.includes("ccWindow")).length).toBe(1);
  });
  test("执行者：策略配成 save-compact、或者退回全局，都改发带清单的 /compact", async () => {
    for (const autoCompact of [{ policies: [{ id: "executor", action: "save-compact" }] }, { window: 100_000, idleHours: 0, policies: [{ id: "executor", enabled: false }] }]) {
      resetCtxBoundaryState();
      const h = harness([], { autoCompact });
      h.deps.agents = async () => [agent({ ctx: 260_000, convTs: h.now })];
      const r = await ctxBoundaryTick(h.deps);
      expect(r[0].boundary.action).toBe("compact");
      expect(h.sent).toEqual([{ target: "master:agent-task-t1", line: `/compact ${DEFAULT_KEEP_LIST}` }]);
    }
  });
});

describe("injectCompact（T35 批量动作的入口）", () => {
  test("画面状态不允许 → skipped 带原因文字，不敲键", async () => {
    for (const [s, reason] of [
      [{ compacting: true }, "compacting"],
      [{ wall: true, lp: "unknown" }, "quota-wall"],
      [{ menu: true }, "menu"],
    ] as const) {
      const h = harness([], { state: s as Partial<PaneQuotaState> });
      const r = await injectCompact("master:x", { action: "compact" }, h.deps);
      expect(r).toMatchObject({ status: "skipped", reason });
      expect((r as { text: string }).text.length).toBeGreaterThan(0);
      expect(h.sent.length).toBe(0);
    }
    const h = harness([], { panes: { "master:x": null } });
    expect(await injectCompact("master:x", { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "pane-unknown" });
  });

  test("闲着 = executed，忙 = queued，发送抛错 = failed；成功注入都记守卫", async () => {
    const h = harness([], { panes: { "master:busy": BUSY_PANE } });
    expect(await injectCompact("master:idle", { action: "compact", keep: "只留卡号" }, h.deps)).toEqual({ status: "executed", line: "/compact 只留卡号" });
    expect(await injectCompact("master:busy", { action: "save-compact" }, h.deps)).toEqual({ status: "queued", line: "/save-compact" });
    // 带了 agentName 的执行者：save-compact 改成 compact（手动按钮 / 批量动作都走这条）
    expect(await injectCompact("master:t", { action: "save-compact", agentName: "agent-task-t9" }, h.deps)).toMatchObject({ line: `/compact ${DEFAULT_KEEP_LIST}` });
    expect(compactInjectedRecently("master:idle", h.now)).toBe(true);
    expect(compactInjectedRecently("master:idle", h.now + 16 * MIN)).toBe(false);
    h.deps.send = async () => {
      throw new Error("no window");
    };
    expect(await injectCompact("master:gone", { action: "compact" }, h.deps)).toEqual({ status: "failed", error: "no window" });
  });
});
