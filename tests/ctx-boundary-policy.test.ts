import { describe, expect, test } from "bun:test";
import {
  BUILTIN_POLICIES, ccLaunchSettings, compactCommand, DEFAULT_KEEP_LIST, effectiveAction, globMatch, isExecutor, matchPolicy, normalizeCompactKeep,
  resolvePolicies,
  type CtxPolicy,
} from "../src/lib/ctx-boundary-policy.js";
import { boundaryDecision, boundaryView, globalBoundary, policyBoundary, type BoundaryInput, type PaneGate } from "../src/lib/ctx-boundary-decision.js";

const byId = (ps: CtxPolicy[], id: string) => ps.find((p) => p.id === id);

describe("resolvePolicies：内置 + 按 id 合并 + 校验", () => {
  test("没写 policies → 只有内置两条（executor / coordinator），数字是 PM 定的", () => {
    const { policies, warnings } = resolvePolicies(undefined);
    expect(warnings).toEqual([]);
    expect(policies.map((p) => p.id)).toEqual(["executor", "coordinator"]);
    expect(byId(policies, "executor")).toMatchObject({ names: ["agent-task-*"], window: 200_000, idleMinutes: 3, hardCap: 250_000, ccWindow: 300_000, action: "compact" });
    expect(byId(policies, "coordinator")).toMatchObject({ names: ["agent-pm-*"], window: 300_000, idleMinutes: 5, hardCap: 400_000, ccWindow: null, action: "save-compact" });
  });

  test("不是数组 → 报一条，按内置", () => {
    const r = resolvePolicies({ id: "x" });
    expect(r.policies).toEqual([...BUILTIN_POLICIES]);
    expect(r.warnings[0].text).toContain("不是数组");
  });

  test("同 id 只写 match → 其余字段沿用内置（PM 要把 agent-claudestra 加进 coordinator 的写法）", () => {
    const { policies, warnings } = resolvePolicies([{ id: "coordinator", match: { names: ["agent-pm-*", "agent-claudestra"] } }]);
    expect(warnings).toEqual([]);
    const c = byId(policies, "coordinator")!;
    expect(c.names).toEqual(["agent-pm-*", "agent-claudestra"]);
    expect(c).toMatchObject({ window: 300_000, hardCap: 400_000, action: "save-compact", idleMinutes: 5 });
    // 配置里写的排前面，没提到的内置排后面
    expect(policies.map((p) => p.id)).toEqual(["coordinator", "executor"]);
  });

  test("enabled:false 关掉一条内置", () => {
    expect(resolvePolicies([{ id: "executor", enabled: false }]).policies.map((p) => p.id)).toEqual(["coordinator"]);
  });

  test("新 id = 新策略；缺 hardCap 按 window，缺 idleMinutes 按 3 分钟，缺 action 按 compact", () => {
    const { policies } = resolvePolicies([{ id: "proj", match: { projects: ["p1"] }, window: 150_000 }]);
    expect(byId(policies, "proj")).toMatchObject({ projects: ["p1"], names: [], window: 150_000, hardCap: 150_000, idleMinutes: 3, action: "compact", ccWindow: null });
  });

  test("ccWindow 只收 10 万～100 万的整数：越界 / 小数都报出来并忽略（CC 自己会悄悄丢掉）", () => {
    for (const v of [30_000, 99_999, 1_000_001, 150_000.5, "300000"]) {
      const { policies, warnings } = resolvePolicies([{ id: "executor", ccWindow: v }]);
      expect(byId(policies, "executor")!.ccWindow).toBeNull();
      expect(warnings.some((w) => w.policy === "executor" && w.text.includes("ccWindow"))).toBe(true);
    }
    expect(byId(resolvePolicies([{ id: "executor", ccWindow: 100_000 }]).policies, "executor")!.ccWindow).toBe(100_000);
    expect(byId(resolvePolicies([{ id: "executor", ccWindow: null }]).policies, "executor")!.ccWindow).toBeNull();
  });

  test("hardCap 不低于 CC 实际压缩点（ccWindow − 3.3 万）→ 报「带清单那一步等不到」，但照样生效", () => {
    const { policies, warnings } = resolvePolicies([{ id: "executor", hardCap: 300_000 }]);
    expect(byId(policies, "executor")!.hardCap).toBe(300_000);
    expect(warnings.some((w) => w.text.includes("CC 会先压"))).toBe(true);
    // 内置的 25 万 / 30 万不报
    expect(resolvePolicies([{ id: "executor", window: 190_000 }]).warnings).toEqual([]);
  });

  test("hardCap < window → 报并按 window；没有匹配条件 / 缺 window / id 重复 / 非对象 → 报并忽略", () => {
    const r = resolvePolicies([
      { id: "a", match: { names: ["x-*"] }, window: 200_000, hardCap: 100_000 },
      { id: "b", window: 100_000 },
      { id: "c", match: { names: ["y-*"] } },
      { id: "a", match: { names: ["z-*"] }, window: 1 },
      7,
    ]);
    expect(byId(r.policies, "a")!.hardCap).toBe(200_000);
    expect(byId(r.policies, "b")).toBeUndefined();
    expect(byId(r.policies, "c")).toBeUndefined();
    expect(byId(r.policies, "a")!.names).toEqual(["x-*"]);
    expect(r.warnings.map((w) => w.policy)).toEqual(["a", "b", "c", "a", null]);
  });

  test("action 写错 → 报并沿用内置；keep 的换行压成一行（tmux 只发一行）", () => {
    const r = resolvePolicies([{ id: "coordinator", action: "clear", keep: "第一条\n  第二条" }]);
    const c = byId(r.policies, "coordinator")!;
    expect(c.action).toBe("save-compact");
    expect(c.keep).toBe("第一条 第二条");
    expect(r.warnings[0].text).toContain("action");
  });

  test("keep 带控制字符或超长 → 报并用默认清单（r3 P2-1：ESC 会打断回合；零宽、方向控制符核对输入框时对不上）", () => {
    const bad = ["保留\x1b卡号", "保留\t卡号", "保留\x7f", "保留\u0085", "保留\u2028卡号", "保留\u2029卡号", "零宽\u200b空格", "方向\u202e控制", "保\ufeff留"];
    for (const k of [...bad, "保".repeat(801)]) {
      const r = resolvePolicies([{ id: "executor", keep: k }]);
      expect(byId(r.policies, "executor")!.keep).toBeNull();
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatchObject({ policy: "executor" });
      expect(r.warnings[0].text).toContain("keep");
    }
    // \r\n、单独的 \r、\n 都换成空格（连同行首尾空白、空行），长度按换完的算；刚好到上限的收下
    const keepOf = (k: string) => byId(resolvePolicies([{ id: "executor", keep: k }]).policies, "executor")!.keep;
    expect(keepOf("第一条\r\n第二条")).toBe("第一条 第二条");
    expect(keepOf("保留卡号\r然后删掉 worktree")).toBe("保留卡号 然后删掉 worktree");
    expect(keepOf("  第一条 \n\n   第二条\r\n")).toBe("第一条 第二条");
    expect(keepOf(`${"保".repeat(400)}  \r\n  ${"留".repeat(399)}`)).toHaveLength(800);
    expect(byId(resolvePolicies([{ id: "executor", keep: "保".repeat(800) }]).policies, "executor")!.keep).toHaveLength(800);
    expect(resolvePolicies([{ id: "executor", keep: "保".repeat(801) }]).warnings[0].text).toContain("超过 800 字（这条 801 字）");
    // 排版用的 ZWNJ / ZWJ / 软连字符放行
    expect(byId(resolvePolicies([{ id: "executor", keep: "a\u200cb\u200dc\u00add" }]).policies, "executor")!.keep).toBe("a\u200cb\u200dc\u00add");
  });

  test("normalizeCompactKeep 是唯一入口（T35 fleet.compactKeep 也调它）：先换行再判，边上的 U+2028 也拒收，长空格串不卡", () => {
    expect(normalizeCompactKeep("保留进度")).toEqual({ ok: true, keep: "保留进度" });
    expect(normalizeCompactKeep("a\nb")).toEqual({ ok: true, keep: "a b" });
    for (const v of ["  ", "\r\n", 3, null, "\u009b", "\u2028保留", "保留\u2029", "\ufeff保留"]) expect(normalizeCompactKeep(v).ok).toBe(false);
    const t0 = performance.now();
    expect(normalizeCompactKeep(`${" ".repeat(200_000)}x`)).toEqual({ ok: true, keep: "x" });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("matchPolicy：项目 + 名字 > 只写项目 > 只写名字", () => {
  const P = (id: string, projects: string[], names: string[]): CtxPolicy => ({
    id, projects, names, window: 1, idleMinutes: 0, hardCap: 1, action: "compact", ccWindow: null, keep: null,
  });
  const ps = [P("name", [], ["agent-task-*"]), P("proj", ["orch"], []), P("both", ["orch"], ["agent-task-*"])];

  test("三级优先", () => {
    expect(matchPolicy(ps, { name: "agent-task-t36", projectId: "orch" })).toMatchObject({ policy: { id: "both" }, via: "project+name" });
    expect(matchPolicy(ps, { name: "agent-relay", projectId: "orch" })).toMatchObject({ policy: { id: "proj" }, via: "project" });
    expect(matchPolicy(ps, { name: "agent-task-t36", projectId: "other" })).toMatchObject({ policy: { id: "name" }, via: "name" });
    expect(matchPolicy(ps, { name: "agent-car-talk", projectId: "personal" })).toBeNull();
  });

  test("同时写了项目和名字的策略要两个都命中；同级取表里第一个", () => {
    expect(matchPolicy([P("both", ["orch"], ["agent-task-*"])], { name: "agent-relay", projectId: "orch" })).toBeNull();
    const two = [P("first", [], ["agent-*"]), P("second", [], ["agent-task-*"])];
    expect(matchPolicy(two, { name: "agent-task-t1" })!.policy.id).toBe("first");
  });

  test("没有 projectId 的 agent 不会被项目策略命中", () => {
    expect(matchPolicy([P("proj", ["orch"], [])], { name: "agent-x", projectId: null })).toBeNull();
  });

  test("大总管：通配符（含 *）不算，只认字面 master / agent-master", () => {
    expect(matchPolicy([P("all", [], ["*"])], { name: "master" })).toBeNull();
    expect(matchPolicy([P("all", [], ["agent-*"])], { name: "agent-master" })).toBeNull();
    expect(matchPolicy([P("m", [], ["master"])], { name: "agent-master" })!.policy.id).toBe("m");
  });

  test("globMatch：* 任意串、? 单字符、整名锚定、正则元字符按字面", () => {
    expect(globMatch("agent-task-*", "agent-task-t36")).toBe(true);
    expect(globMatch("agent-task-*", "xagent-task-t36")).toBe(false);
    expect(globMatch("agent-t?", "agent-t3")).toBe(true);
    expect(globMatch("agent-t?", "agent-t36")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a+(b)", "a+(b)")).toBe(true);
  });
});

describe("globalBoundary：没命中策略的 agent，口径与原 stats-dashboard 一致", () => {
  test("缺省 40 万 / 3 小时 / 救命线开；拿不到真实窗口时没有救命线", () => {
    expect(globalBoundary(undefined, null)).toMatchObject({ policy: "global", window: 400_000, hardCap: null, idleMs: 3 * 3600_000, action: "save-compact" });
  });
  test("有真实窗口：软线收到 85%，救命线 93%", () => {
    expect(globalBoundary({ window: 900_000 }, 1_000_000)).toMatchObject({ window: 850_000, hardCap: 930_000 });
    expect(globalBoundary({ window: 450_000, idleHours: 0.2 }, 1_000_000)).toMatchObject({ window: 450_000, idleMs: 720_000 });
  });
  test("window=0 关软线，救命线照样在；emergency=false 关救命线；idleHours=0 = 不要闲置门槛", () => {
    expect(globalBoundary({ window: 0 }, 1_000_000)).toMatchObject({ window: 0, hardCap: 930_000 });
    expect(globalBoundary({ emergency: false }, 1_000_000).hardCap).toBeNull();
    expect(globalBoundary({ idleHours: 0 }, null).idleMs).toBe(0);
  });
});

describe("policyBoundary", () => {
  const exec = { policy: BUILTIN_POLICIES[0], via: "name" as const };
  test("原样取策略的线", () => {
    expect(policyBoundary(exec, null)).toMatchObject({ policy: "executor", window: 200_000, hardCap: 250_000, idleMs: 180_000, action: "compact", ccWindow: 300_000 });
  });
  test("小窗口模型上不越过真实窗口的 85% / 93%", () => {
    expect(policyBoundary(exec, 200_000)).toMatchObject({ window: 170_000, hardCap: 186_000 });
  });
});

describe("boundaryDecision：决策表", () => {
  const clear: PaneGate = {
    wall: false, lp: "off", exhausted: false, menu: false, compacting: false, draft: false, queued: false, apiRetry: false, copyMode: false, notCc: false,
  };
  const base: BoundaryInput = {
    ctx: 210_000, window: 200_000, hardCap: 250_000, idle: true, pane: clear, injectedRecently: false,
    lastTrig: 0, now: 1_000_000_000, retryMs: 30 * 60_000,
  };
  const d = (o: Partial<BoundaryInput>) => boundaryDecision({ ...base, ...o });

  test("没过线 → 不动", () => expect(d({ ctx: 199_999 })).toEqual({ fire: false, reason: "under" }));
  test("过软线 + 闲置 → 闲置触发", () => expect(d({})).toEqual({ fire: true, kind: "idle" }));
  test("过软线但在忙 → 等", () => expect(d({ idle: false })).toEqual({ fire: false, reason: "busy" }));
  test("过硬上限 → 忙也触发（排队到回合结束）", () => expect(d({ ctx: 250_000, idle: false })).toEqual({ fire: true, kind: "hard-cap" }));

  test("撞墙没开 LP（off / unknown）→ 不注入；开着 LP → 照常", () => {
    expect(d({ pane: { ...clear, wall: true, lp: "off" } })).toEqual({ fire: false, reason: "quota-wall" });
    expect(d({ ctx: 300_000, pane: { ...clear, wall: true, lp: "unknown" } })).toEqual({ fire: false, reason: "quota-wall" });
    expect(d({ ctx: 300_000, idle: false, pane: { ...clear, wall: true, lp: "on" } })).toEqual({ fire: true, kind: "hard-cap" });
  });

  test("撞墙不占重试计时：它排在冷却之后判，且不开火（调用方不记 lastTrig）", () => {
    expect(d({ lastTrig: base.now - 5 * 60_000, pane: { ...clear, wall: true } })).toEqual({ fire: false, reason: "retry-wait" });
  });

  test("画面上有选择菜单 → 不敲键（额度墙菜单第 3 项是花钱的）", () => {
    expect(d({ ctx: 900_000, pane: { ...clear, menu: true } })).toEqual({ fire: false, reason: "menu" });
  });

  test("正在压缩：画面显示压缩中，或压缩途中 API 在重试（adv1 P2-1）；bridge 刚注入过 → recent", () => {
    expect(d({ pane: { ...clear, compacting: true } })).toEqual({ fire: false, reason: "compacting" });
    expect(d({ ctx: 900_000, idle: false, pane: { ...clear, apiRetry: true } })).toEqual({ fire: false, reason: "api-retry" });
    expect(d({ ctx: 900_000, injectedRecently: true })).toEqual({ fire: false, reason: "recent" });
  });

  test("CC 已退出只剩 shell、有人在 copy-mode 翻历史 → 硬上限也不发键（adv1 P2-3 / P2-4）", () => {
    expect(d({ ctx: 900_000, pane: { ...clear, notCc: true } })).toEqual({ fire: false, reason: "not-cc" });
    expect(d({ ctx: 900_000, pane: { ...clear, copyMode: true } })).toEqual({ fire: false, reason: "copy-mode" });
  });

  test("30 分钟重试：之内不重复注入（硬上限也遵守），过了再来", () => {
    expect(d({ ctx: 300_000, lastTrig: base.now - 10 * 60_000 })).toEqual({ fire: false, reason: "retry-wait" });
    expect(d({ ctx: 300_000, lastTrig: base.now - 31 * 60_000 })).toEqual({ fire: true, kind: "hard-cap" });
  });

  test("读不到画面 → 不盲敲；已有排队消息 → 不叠第二条", () => {
    expect(d({ pane: null })).toEqual({ fire: false, reason: "pane-unknown" });
    expect(d({ ctx: 300_000, pane: { ...clear, queued: true, draft: true } })).toEqual({ fire: false, reason: "queued" });
  });

  // 原 stats-dashboard autoCompactDecision 的用例，换成全局口径（软线 85 万 / 救命线 93 万）
  describe("全局口径：常规线 / 93% 救命线", () => {
    const g = { ...base, window: 850_000, hardCap: 930_000 as number | null };
    test("超线且闲置 → 开火；超线但忙 → 不开火", () => {
      expect(boundaryDecision({ ...g, ctx: 860_000 })).toEqual({ fire: true, kind: "idle" });
      expect(boundaryDecision({ ...g, ctx: 860_000, idle: false }).fire).toBe(false);
    });
    test("忙碌中踩到救命线 → 无视闲置开火", () => {
      expect(boundaryDecision({ ...g, ctx: 935_000, idle: false })).toEqual({ fire: true, kind: "hard-cap" });
    });
    test("常规线关（window=0）时救命线照样兜底；两条都关 → 静默", () => {
      expect(boundaryDecision({ ...g, window: 0, ctx: 935_000, idle: false })).toEqual({ fire: true, kind: "hard-cap" });
      expect(boundaryDecision({ ...g, window: 0, ctx: 900_000 }).fire).toBe(false);
      expect(boundaryDecision({ ...g, window: 0, hardCap: null, ctx: 990_000 }).fire).toBe(false);
    });
    test("拿不到真实窗口（没有救命线）时常规线仍按绝对值工作", () => {
      expect(boundaryDecision({ ...g, hardCap: null, ctx: 860_000 })).toEqual({ fire: true, kind: "idle" });
    });
  });
});

describe("boundaryView / compactCommand / ccLaunchSettings", () => {
  const b = policyBoundary({ policy: BUILTIN_POLICIES[0], via: "name" }, null);
  test("等级：线下 ok、过软线 over（黄）、过硬上限 cap（红）；remaining 负数 = 已超出", () => {
    expect(boundaryView(b, 150_000)).toMatchObject({ level: "ok", remaining: 50_000, policy: "executor" });
    expect(boundaryView(b, 220_000)).toMatchObject({ level: "over", remaining: -20_000 });
    expect(boundaryView(b, 260_000)).toMatchObject({ level: "cap" });
    expect(boundaryView(b, null)).toMatchObject({ level: "ok", remaining: null });
  });
  test("只带本策略的配置警告", () => {
    const v = boundaryView(b, 1, [{ policy: "executor", text: "x" }, { policy: "other", text: "y" }, { policy: null, text: "z" }]);
    expect(v.warnings).toEqual(["x"]);
  });
  test("全局软线关（window 0）→ remaining 为 null", () => {
    expect(boundaryView(globalBoundary({ window: 0 }, null), 500_000)).toMatchObject({ remaining: null, level: "ok" });
  });
  test("压缩命令：compact 带清单（一行），save-compact 就是技能名", () => {
    expect(compactCommand("compact", null)).toBe(`/compact ${DEFAULT_KEEP_LIST}`);
    expect(compactCommand("compact", "只留卡号")).toBe("/compact 只留卡号");
    expect(compactCommand("save-compact", "忽略")).toBe("/save-compact");
    expect(DEFAULT_KEEP_LIST).not.toContain("\n");
  });
  test("第 1 层：有 ccWindow 才带 autoCompactWindow", () => {
    expect(ccLaunchSettings({ policy: BUILTIN_POLICIES[0], via: "name" })).toEqual({ autoCompactWindow: 300_000 });
    expect(ccLaunchSettings({ policy: BUILTIN_POLICIES[1], via: "name" })).toEqual({});
    expect(ccLaunchSettings(null)).toEqual({});
  });
});

describe("执行者不跑 save-compact（worktree 里写主仓 memory，会覆盖 PM 的 HANDOFF）", () => {
  test("effectiveAction：执行者的 save-compact 改成 compact；其余不动", () => {
    expect(effectiveAction(true, "save-compact")).toBe("compact");
    expect(effectiveAction(true, "compact")).toBe("compact");
    expect(effectiveAction(false, "save-compact")).toBe("save-compact");
  });
  test("isExecutor：名字是 agent-task-*，或者目录是 linked worktree（换了名字的 worktree agent 也算）", () => {
    expect(isExecutor({ name: "agent-task-t36" })).toBe(true);
    expect(isExecutor({ name: "agent-foo", worktree: true })).toBe(true);
    expect(isExecutor({ name: "agent-pm-dispatch", worktree: false })).toBe(false);
    expect(isExecutor({ name: "agent-car-talk" })).toBe(false);
  });
  test("配了 save-compact、又可能命中执行者的策略 → 警告；只命中协调者的不报", () => {
    const hit = (m: object) =>
      resolvePolicies([{ id: "p", match: m, window: 100_000, action: "save-compact" }]).warnings.some((w) => w.text.includes("HANDOFF"));
    expect(hit({ names: ["agent-task-*"] })).toBe(true);
    expect(hit({ names: ["agent-*"] })).toBe(true);
    expect(hit({ names: ["*"] })).toBe(true);
    expect(hit({ names: ["agent-task-t36"] })).toBe(true);
    expect(hit({ projects: ["orch"] })).toBe(true); // 只写项目：这个项目里的执行者也会命中
    expect(hit({ names: ["agent-pm-*"] })).toBe(false);
    expect(hit({ names: ["agent-car-*"] })).toBe(false);
    expect(hit({ projects: ["orch"], names: ["agent-pm-*"] })).toBe(false);
    expect(resolvePolicies([{ id: "executor", action: "save-compact" }]).warnings.some((w) => w.text.includes("HANDOFF"))).toBe(true);
    expect(resolvePolicies(undefined).warnings).toEqual([]); // 内置的 coordinator 只匹配 agent-pm-*，不报
  });
});

describe("第 1 轮审查补的：match 替换语义 / 宽模式抢执行者 / 草稿 / 余量用完 / 保留清单", () => {
  test("同 id 写了 match 就整个替换（只写 projects 不再和继承来的 names 取「且」）", () => {
    const e = resolvePolicies([{ id: "executor", match: { projects: ["orch"] } }]).policies.find((p) => p.id === "executor")!;
    expect(e.projects).toEqual(["orch"]);
    expect(e.names).toEqual([]);
  });
  test("match 写成字符串 → 报警告、按没写处理（沿用内置的匹配条件）", () => {
    const r = resolvePolicies([{ id: "executor", match: "agent-task-*" }]);
    expect(r.warnings.some((w) => w.policy === "executor" && w.text.includes("match 必须是对象"))).toBe(true);
    expect(r.policies.find((p) => p.id === "executor")!.names).toEqual(["agent-task-*"]);
  });
  test("写成空 match（names: []）→ 报警告并说明内置策略也随之失效", () => {
    const r = resolvePolicies([{ id: "executor", match: { names: [] } }]);
    expect(r.policies.some((p) => p.id === "executor")).toBe(false);
    expect(r.warnings.some((w) => w.policy === "executor" && w.text.includes("enabled:false"))).toBe(true);
  });
  test("宽模式排在内置 executor 前面 / 只写项目 → 报「会抢在 executor 之前」；只命中协调者的不报", () => {
    const pre = (e: object) => resolvePolicies([{ id: "x", window: 900_000, ...e }]).warnings.some((w) => w.policy === "x" && w.text.includes("抢在内置 executor"));
    expect(pre({ match: { names: ["agent-*"] } })).toBe(true);
    expect(pre({ match: { projects: ["orch"] } })).toBe(true);
    expect(pre({ match: { names: ["agent-pm-*"] } })).toBe(false);
    // executor 被关掉就没有「抢」这回事
    expect(resolvePolicies([{ id: "executor", enabled: false }, { id: "x", window: 1, match: { names: ["agent-*"] } }]).warnings).toEqual([]);
  });
  test("决策表：输入框有草稿 → 不注入，硬上限也不例外；LP 余量用完 → 按撞墙处理", () => {
    const pane: PaneGate = {
      wall: false, lp: "off", exhausted: false, menu: false, compacting: false, draft: true, queued: false, apiRetry: false, copyMode: false, notCc: false,
    };
    const base: BoundaryInput = { ctx: 900_000, window: 200_000, hardCap: 250_000, idle: false, pane, injectedRecently: false, lastTrig: 0, now: 1, retryMs: 1 };
    expect(boundaryDecision(base)).toEqual({ fire: false, reason: "draft" });
    expect(boundaryDecision({ ...base, pane: { ...pane, draft: false, wall: true, lp: "on", exhausted: true } })).toEqual({ fire: false, reason: "quota-wall" });
  });
  test("默认保留清单带上「在等谁的回复」和「值守 / Autopilot 的目标」", () => {
    expect(DEFAULT_KEEP_LIST).toContain("在等谁的回复");
    expect(DEFAULT_KEEP_LIST).toContain("Autopilot");
  });
});
