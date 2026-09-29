import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ctxBoundaryTick, injectCompact, isLinkedWorktree, resetCtxBoundaryState } from "../src/bridge/ctx-boundary.js";
import { DEFAULT_KEEP_LIST } from "../src/lib/ctx-boundary-policy.js";
import { agent, BUSY_PANE, harness, MIN, tgt } from "./ctx-boundary-harness.js";

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

  test("自动注入缺省关：不读画面、不发键，日志只提示一次；打开后照常", async () => {
    const h = harness([], { autoCompact: { inject: false } });
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: 0 })];
    expect(await ctxBoundaryTick(h.deps)).toEqual([]);
    expect(await ctxBoundaryTick(h.deps)).toEqual([]);
    expect(h.logs.filter((l) => l.includes("自动注入关着")).length).toBe(1);
    const off = harness([], { autoCompact: null });
    off.deps.agents = h.deps.agents;
    expect(await ctxBoundaryTick(off.deps)).toEqual([]);
    expect(h.sent.length + off.sent.length).toBe(0);
  });

  test("dry-run：开关关着也照常判定，只给出会发的那行，不发键、不记冷却、不提醒", async () => {
    const h = harness([], { autoCompact: { inject: false } });
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: 0 })];
    const dry = { ...h.deps, dryRun: true };
    const r = await ctxBoundaryTick(dry);
    expect(r[0]).toMatchObject({ verdict: { fire: true, kind: "hard-cap" }, would: `/compact ${DEFAULT_KEEP_LIST}` });
    expect(r[0].inject).toBeUndefined();
    expect((await ctxBoundaryTick(dry))[0].verdict.fire).toBe(true); // 没记冷却
    h.state.draft = true;
    expect((await ctxBoundaryTick(dry))[0].verdict).toEqual({ fire: false, reason: "draft" });
    expect([h.sent.length, h.alerts.length]).toEqual([0, 0]);
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

  test("画面上有选择菜单 / 读不到画面 / 已有排队消息 / CC 已退出 / copy-mode → 不敲键", async () => {
    for (const [o, reason, tweak] of [
      [{ state: { menu: true } }, "menu"],
      [{ panes: { "master:agent-task-t1": null } }, "pane-unknown"],
      [{ panes: { "master:agent-task-t1": "❯ /compact x\n  Press up to edit queued messages\n" } }, "queued"],
      [{}, "not-cc", { command: "zsh" }],
      [{}, "copy-mode", { inMode: true }],
    ] as const) {
      resetCtxBoundaryState();
      const h = harness([], o as any);
      Object.assign(h.win("master:agent-task-t1"), tweak ?? {});
      h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
      expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason });
      expect(h.sent.length).toBe(0);
    }
  });

  test("手动按钮刚注入过 → 自动这边 15 分钟内不叠一条", async () => {
    const h = harness([]);
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
    await injectCompact(tgt("agent-task-t1", true), { action: "save-compact" }, h.deps);
    h.advance(MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "recent" });
    expect(h.sent.length).toBe(1);
  });

  test("/clear 之后 registry 还指着旧会话：按窗口里实际的会话重读，新会话没过线就不压（adv1 P2-12）", async () => {
    const h = harness([]);
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: 0, sessionId: "old" })];
    h.deps.liveSession = async (a) => ({ ...a, sessionId: "new", ctx: 12_000 });
    expect(await ctxBoundaryTick(h.deps)).toEqual([]);
    h.deps.liveSession = async (a) => ({ ...a, sessionId: "new", ctx: 260_000, convTs: h.now });
    expect((await ctxBoundaryTick(h.deps))[0]).toMatchObject({ ctx: 260_000, verdict: { fire: true, kind: "hard-cap" } });
  });

  test("没命中策略的个人 agent：走全局（线 / 闲置小时 / save-compact），也过画面判定", async () => {
    const h = harness([], { autoCompact: { window: 450_000, idleHours: 0.2 } });
    const car = agent({ name: "agent-car-talk", projectId: "personal", target: "master:agent-car-talk", ctx: 800_000, convTs: 0 });
    h.deps.agents = async () => [car, agent({ name: "agent-gc-car", projectId: "personal", target: "master:agent-gc-car", ctx: 400_000, convTs: 0 })];
    car.convTs = h.now - 10 * MIN; // 0.2 小时 = 12 分钟，还差 2 分钟
    const r = await ctxBoundaryTick(h.deps);
    expect(r.map((x) => [x.agent, x.boundary.policy, x.verdict])).toEqual([["agent-car-talk", "global", { fire: false, reason: "busy" }]]);
    h.advance(3 * MIN);
    h.state.menu = true;
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "menu" });
    h.state.menu = false;
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

  test("输入框有草稿 → 硬上限也不注入；过救命线被挡就提醒 owner，同一个 agent 30 分钟最多一次（adv1 P2-6）", async () => {
    const h = harness([], { state: { draft: true } });
    h.deps.agents = async () => [agent({ ctx: 400_000, convTs: h.now }), agent({ name: "agent-task-soft", target: "master:agent-task-soft", ctx: 210_000 })];
    expect((await ctxBoundaryTick(h.deps)).map((x) => x.verdict)).toEqual([{ fire: false, reason: "draft" }, { fire: false, reason: "draft" }]);
    expect(h.alerts).toEqual([{ agent: "agent-task-t1", text: expect.stringContaining("过了救命线"), data: { ctx: 400_000, cap: 250_000, reason: "draft" } }]);
    h.advance(10 * MIN);
    await ctxBoundaryTick(h.deps);
    expect(h.alerts.length).toBe(1); // 只过软线的那个不提醒；30 分钟内不重复
    h.advance(21 * MIN);
    await ctxBoundaryTick(h.deps);
    expect(h.alerts.length).toBe(2);
    h.state.draft = false; // 发出去了 / 清掉了：下一轮照常
    h.advance(MIN);
    expect((await ctxBoundaryTick(h.deps)).map((x) => x.verdict)).toEqual([{ fire: true, kind: "hard-cap" }, { fire: true, kind: "idle" }]);
    expect(h.sent.map((x) => x.target)).toEqual(["master:agent-task-t1", "master:agent-task-soft"]);
  });

  test("发送失败：日志带错误原文，不记注入守卫，5 分钟后重试（不进 30 分钟沉默期）", async () => {
    const h = harness([]);
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
    const type = h.deps.type;
    let fail = true;
    h.deps.type = async (t, text) => {
      if (fail) throw new Error("can't find window");
      await type(t, text);
    };
    const r = await ctxBoundaryTick(h.deps);
    expect(r[0].inject).toEqual({ status: "failed", error: "can't find window" });
    expect(h.logs.some((l) => l.includes("failed（can't find window）"))).toBe(true);
    h.advance(4 * MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict).toEqual({ fire: false, reason: "retry-wait" });
    fail = false;
    h.advance(2 * MIN);
    expect((await ctxBoundaryTick(h.deps))[0].inject?.status).toBe("executed");
    expect(h.sent.length).toBe(1);
  });

  test("敲完字弹出对话框：不回车、提醒 owner；对话框关掉后下一轮把自己敲的字删掉，再照常注入（adv1 P2-9）", async () => {
    const h = harness([]);
    h.deps.agents = async () => [agent({ ctx: 300_000, convTs: h.now })];
    const w = h.win("master:agent-task-t1");
    w.onType = (win) => void (win.pane = "Do you want to proceed?\n[menu]");
    const r = await ctxBoundaryTick(h.deps);
    expect(r[0].inject).toMatchObject({ status: "failed", leftover: true });
    expect(h.sent.length).toBe(0);
    expect(h.alerts[0].data.reason).toBe("leftover");
    w.onType = undefined;
    h.advance(MIN);
    await ctxBoundaryTick(h.deps); // 对话框还在：不动
    expect(w.box).toBe(`/compact ${DEFAULT_KEEP_LIST}`);
    w.pane = "some output\n❯ \n"; // owner 答完对话框
    h.advance(5 * MIN);
    await ctxBoundaryTick(h.deps);
    expect(h.logs.some((l) => l.includes("已删掉"))).toBe(true);
    expect(h.sent).toEqual([{ target: "master:agent-task-t1", line: `/compact ${DEFAULT_KEEP_LIST}` }]); // 同一轮删完就照常注入
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
});

describe("isLinkedWorktree（执行者认法的 worktree 兜底，adv1 P2-8）", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxb-wt-"));
  const repo = (name: string, git: string | null) => {
    const d = join(root, name, "sub");
    mkdirSync(d, { recursive: true });
    if (git === null) mkdirSync(join(root, name, ".git"));
    else writeFileSync(join(root, name, ".git"), git);
    return d;
  };
  test("gitdir 指向 …/worktrees/<名字> 才算；submodule（…/modules/…）和普通仓库都不算", () => {
    expect(isLinkedWorktree(repo("wt", "gitdir: /r/.git/worktrees/wt-t36\n"))).toBe(true);
    expect(isLinkedWorktree(repo("sm", "gitdir: ../.git/modules/vendor/lib\n"))).toBe(false);
    expect(isLinkedWorktree(repo("plain", null))).toBe(false);
    expect(isLinkedWorktree(null)).toBe(false);
  });
});
