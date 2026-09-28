import { beforeEach, describe, expect, test } from "bun:test";
import {
  compactInjectedRecently, ctxBoundaryTick, injectCompact, noteCompactInjected, resetCtxBoundaryState,
  type BoundaryAgent, type CtxBoundaryDeps,
} from "../src/bridge/ctx-boundary.js";
import { DEFAULT_KEEP_LIST } from "../src/lib/ctx-boundary-policy.js";
import type { PaneQuotaState } from "../src/lib/lp-state.js";

const MIN = 60_000;
const IDLE_PANE = "some output\n❯ \n";
const BUSY_PANE = "· Thinking… (esc to interrupt)\n❯ \n";

function harness(
  agents: BoundaryAgent[],
  opts: { panes?: Record<string, string | null>; state?: Partial<PaneQuotaState>; autoCompact?: any; gateGlobal?: boolean } = {},
) {
  let now = 1_000_000_000;
  const sent: { target: string; line: string }[] = [];
  const logs: string[] = [];
  const state: PaneQuotaState = { wall: false, lp: "off", exhausted: false, menu: false, compacting: false, draft: false, ...opts.state };
  const deps: CtxBoundaryDeps = {
    now: () => now,
    agents: async () => agents,
    capture: async (t) => {
      const p = opts.panes && t in opts.panes ? opts.panes[t] : IDLE_PANE;
      return p === null ? null : { plain: p, esc: p };
    },
    paneState: () => state,
    send: async (target, line) => void sent.push({ target, line }),
    autoCompact: () => opts.autoCompact,
    log: (l) => void logs.push(l),
    gateGlobal: opts.gateGlobal ?? false,
  };
  return { deps, sent, logs, state, advance: (ms: number) => (now += ms), get now() { return now; } };
}

const agent = (o: Partial<BoundaryAgent>): BoundaryAgent => {
  const name = o.name ?? "agent-task-t1";
  return { name, projectId: "orch", target: `master:${name}`, executor: name.startsWith("agent-task-"), ctx: 0, convTs: 0, mtime: 0, realWindow: null, ...o };
};
const tgt = (name: string, executor = false) => ({ name, target: `master:${name}`, executor });

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
  test("输入框有草稿（owner 打了一半）→ 硬上限也不注入，免得把草稿连着 /compact 一起提交", async () => {
    const h = harness([], { state: { draft: true } });
    h.deps.agents = async () => [agent({ ctx: 400_000, convTs: h.now })];
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "draft" });
    expect(h.sent.length).toBe(0);
    h.state.draft = false; // 发出去了 / 清掉了：下一轮照常
    h.advance(MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: true, kind: "hard-cap" });
  });

  test("发送失败：日志带错误原文，不记注入守卫，5 分钟后重试（不进 30 分钟沉默期）", async () => {
    const h = harness([]);
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
    let fail = true;
    h.deps.send = async (target, line) => {
      if (fail) throw new Error("can't find window");
      h.sent.push({ target, line });
    };
    const r = await ctxBoundaryTick(h.deps);
    expect(r[0].inject).toEqual({ status: "failed", error: "can't find window" });
    expect(h.logs.some((l) => l.includes("failed（can't find window）"))).toBe(true);
    expect(compactInjectedRecently("master:agent-task-t1", h.now)).toBe(false);
    h.advance(4 * MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "retry-wait" });
    fail = false;
    h.advance(2 * MIN);
    expect((await ctxBoundaryTick(h.deps))[0].inject?.status).toBe("executed");
    expect(h.sent.length).toBe(1);
  });
  test("lp-state 到位前（占位判定 = 有菜单 + 草稿）：具名策略不注入；个人 agent 走全局旧口径，过线照样压，93% 救命线照常", async () => {
    const placeholder = { state: { menu: true, draft: true, lp: "unknown" as const }, autoCompact: { window: 450_000, idleHours: 0.2 } };
    const h = harness([], placeholder);
    h.deps.agents = async () => [
      agent({ ctx: 300_000, convTs: 0 }),
      agent({ name: "agent-car-talk", projectId: "personal", ctx: 800_000, convTs: 0 }),
      agent({ name: "agent-gc-car", projectId: "personal", ctx: 935_000, convTs: h.now, mtime: h.now, realWindow: 1_000_000 }),
    ];
    const r = await ctxBoundaryTick(h.deps);
    expect(r.map((x) => [x.agent, x.verdict])).toEqual([
      ["agent-task-t1", { fire: false, reason: "menu" }],
      ["agent-car-talk", { fire: true, kind: "idle" }],
      ["agent-gc-car", { fire: true, kind: "hard-cap" }], // 在忙也照样过救命线
    ]);
    expect(h.sent.map((x) => x.line)).toEqual(["/save-compact", "/save-compact"]);
  });

  test("全局路径的闲置 = 新口径且旧 mtime 口径：最后对话早了但文件刚写过 → 不算闲；具名策略只看新口径", async () => {
    const h = harness([], { autoCompact: { window: 450_000, idleHours: 0.2 } });
    h.deps.agents = async () => [
      agent({ name: "agent-car-talk", projectId: "personal", ctx: 800_000, convTs: 0, mtime: h.now - 5 * MIN }),
      agent({ ctx: 210_000, convTs: h.now - 5 * MIN, mtime: h.now }),
    ];
    const r = await ctxBoundaryTick(h.deps);
    expect(r.map((x) => [x.agent, x.verdict])).toEqual([
      ["agent-car-talk", { fire: false, reason: "busy" }],
      ["agent-task-t1", { fire: true, kind: "idle" }],
    ]);
  });

  test("gateGlobal 打开（lp-state 合进来之后）：个人 agent 也过画面判定", async () => {
    const h = harness([], { state: { menu: true }, autoCompact: { window: 450_000, idleHours: 0 }, gateGlobal: true });
    h.deps.agents = async () => [agent({ name: "agent-car-talk", projectId: "personal", ctx: 800_000 })];
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "menu" });
  });
});

describe("injectCompact（T35 批量动作的入口）", () => {
  test("画面状态不允许 → skipped 带原因文字，不敲键", async () => {
    for (const [s, reason] of [
      [{ compacting: true }, "compacting"],
      [{ wall: true, lp: "unknown" }, "quota-wall"],
      [{ menu: true }, "menu"],
      [{ draft: true }, "draft"],
      [{ exhausted: true, wall: true, lp: "on" }, "quota-wall"],
    ] as const) {
      const h = harness([], { state: s as Partial<PaneQuotaState> });
      const r = await injectCompact(tgt("x"), { action: "compact" }, h.deps);
      expect(r).toMatchObject({ status: "skipped", reason });
      expect((r as { text: string }).text.length).toBeGreaterThan(0);
      expect(h.sent.length).toBe(0);
    }
    const h = harness([], { panes: { "master:x": null } });
    expect(await injectCompact(tgt("x"), { action: "compact" }, h.deps)).toMatchObject({ status: "skipped", reason: "pane-unknown" });
  });

  test("闲着 = executed，忙 = queued，发送抛错 = failed；成功注入都记守卫", async () => {
    const h = harness([], { panes: { "master:busy": BUSY_PANE } });
    expect(await injectCompact(tgt("idle"), { action: "compact", keep: "只留卡号" }, h.deps)).toEqual({ status: "executed", line: "/compact 只留卡号" });
    expect(await injectCompact(tgt("busy"), { action: "save-compact" }, h.deps)).toEqual({ status: "queued", line: "/save-compact" });
    // 执行者（名字或 worktree 判定）：save-compact 改成 compact（手动按钮 / 批量动作都走这条）
    expect(await injectCompact(tgt("agent-foo", true), { action: "save-compact" }, h.deps)).toMatchObject({ line: `/compact ${DEFAULT_KEEP_LIST}` });
    expect(compactInjectedRecently("master:idle", h.now)).toBe(true);
    expect(compactInjectedRecently("master:idle", h.now + 16 * MIN)).toBe(false);
    h.deps.send = async () => {
      throw new Error("no window");
    };
    expect(await injectCompact(tgt("gone"), { action: "compact" }, h.deps)).toEqual({ status: "failed", error: "no window" });
  });

  test("gate:false（Discord 手动按钮，lp-state 到位前）：不看画面照发；执行者照样改 compact", async () => {
    const h = harness([], { state: { menu: true, draft: true } });
    expect(await injectCompact(tgt("car"), { action: "save-compact", gate: false }, h.deps)).toEqual({ status: "executed", line: "/save-compact" });
    expect(await injectCompact(tgt("agent-task-t1", true), { action: "save-compact", gate: false }, h.deps)).toMatchObject({ line: `/compact ${DEFAULT_KEEP_LIST}` });
  });

  test("读不到画面（窗口不在）：gate:false 也不发，不假报「已开始」", async () => {
    const h = harness([], { panes: { "master:gone": null } });
    expect(await injectCompact(tgt("gone"), { action: "save-compact", gate: false }, h.deps)).toMatchObject({ status: "skipped", reason: "pane-unknown" });
    expect(h.sent.length).toBe(0);
  });
});
