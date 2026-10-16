/**
 * agents-ACTIONSTATE1 纯函数 actionState 的表驱动测试：五组各有命中例与优先级，STUCKVIEW1·2 的时长边界，
 * ask / 心跳 / CI 的排除条件，缺事实不猜，纯度（不改输入、同输入同输出）。
 */
import { describe, expect, test } from "bun:test";
import { actionState, CI_REPEAT_FAILS, type ActionAsk, type ActionGroup, type ActionInput } from "../src/lib/action-state";
import { FIX_STUCK_MS, STUCK_MS } from "../src/lib/action-state-thresholds";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HEAD = "a".repeat(40);

const base = (over: Partial<ActionInput> = {}): ActionInput => ({
  now: NOW, taskId: "t1", stage: "build", restating: false, stageSince: NOW - 5 * MIN, stageSinceApprox: false, asks: [], mergePhase: null,
  ci: null, heartbeat: { state: "live", at: NOW - MIN }, placement: { where: "local", peer: null, family: null }, instance: null,
  frozen: false, observationUntil: null, blockedBy: [], specReady: true, paused: false, delegated: false, lastEvent: null, canPause: false, ...over,
});
const ask = (over: Partial<ActionAsk> = {}): ActionAsk => ({
  id: "ask1", kind: "decide", source: "reply", forOwner: true, state: "open", expiresAt: NOW + 60 * MIN, createdAt: NOW - 3 * MIN, ...over,
});
const dwell = (ms: number, stage: ActionInput["stage"], over: Partial<ActionInput> = {}) => base({ stage, stageSince: NOW - ms, ...over });
const g = (i: ActionInput) => actionState(i).group;

describe("五组各有命中例", () => {
  const cases: [string, ActionInput, ActionGroup][] = [
    ["owner ask → 要你做", base({ asks: [ask()] }), "owner"],
    ["AUQ → 要你做", base({ asks: [ask({ source: "auq" })] }), "owner"],
    ["权限请求 → 要你做（不要求 blocking）", base({ asks: [ask({ source: "permission", kind: "authorize" })] }), "owner"],
    ["blocked → 出问题", base({ stage: "blocked" }), "problem"],
    ["build → 在做", base(), "active"],
    ["review → 在做（审查不是 owner 工作）", base({ stage: "review" }), "active"],
    ["merge 等 CI → 在做", base({ stage: "merge", mergePhase: "await_ci" }), "active"],
    ["restate 意图已派 → 在做", base({ stage: "spec", restating: true }), "active"],
    ["spec 未开工 → 排队", base({ stage: "spec" }), "queued"],
    ["依赖未满足 → 排队", base({ blockedBy: ["t0"] }), "queued"],
    ["已暂停 → 排队", base({ paused: true }), "queued"],
    ["已冻结 → 排队", base({ frozen: true }), "queued"],
    ["live → 能用", base({ stage: "live" }), "usable"],
    ["verified → 能用", base({ stage: "verified" }), "usable"],
    ["done → 能用", base({ stage: "done" }), "usable"],
  ];
  for (const [name, input, group] of cases) test(name, () => expect(g(input)).toBe(group));
});

describe("优先级：自上而下第一个命中", () => {
  test("owner ask 压过失败", () => {
    const s = actionState(base({ stage: "blocked", heartbeat: { state: "disconnected", at: NOW }, asks: [ask()] }));
    expect([s.group, s.waitingOn, s.health]).toEqual(["owner", "owner", "disconnected"]);
    expect(s.actions).toEqual([{ kind: "answer", askId: "ask1" }]);
  });
  test("失败压过进行态", () => expect(g(base({ lastEvent: { kind: "rollback", ts: NOW - MIN } }))).toBe("problem"));
  test("冻结 / 暂停 / 依赖压过普通进行态", () => {
    for (const over of [{ frozen: true }, { paused: true }, { blockedBy: ["x"] }]) expect(g(base({ stage: "fix", ...over }))).toBe("queued");
  });
  test("冻结 / 暂停不能消除明确故障", () => {
    expect(g(base({ frozen: true, stage: "blocked" }))).toBe("problem");
    expect(g(base({ paused: true, heartbeat: { state: "stale", at: NOW - 9 * MIN } }))).toBe("problem");
    expect(g(base({ frozen: true, stage: "live", lastEvent: { kind: "verify", ts: NOW, result: "fail" } }))).toBe("problem");
  });
  test("观察期内 live 归能用、附观察中；观察期内检查没过仍出问题", () => {
    const s = actionState(base({ stage: "live", stageSince: NOW - 10 * 60 * MIN, observationUntil: NOW + MIN }));
    expect([s.group, s.tag]).toEqual(["usable", "观察中"]);
    expect(g(base({ stage: "live", observationUntil: NOW + MIN, lastEvent: { kind: "verify", ts: NOW, result: "unknown" } }))).toBe("problem");
  });
  test("cancelled 归排队、tag 已取消、actions 为空（有 owner ask 也一样）", () => {
    const s = actionState(base({ stage: "cancelled", asks: [ask()], canPause: true }));
    expect([s.group, s.tag, s.actions]).toEqual(["queued", "已取消", []]);
  });
});

describe("fix 2 小时边界（>= FIX_STUCK_MS）", () => {
  test("前一毫秒是在做、恰好两小时是出问题", () => {
    expect(g(dwell(FIX_STUCK_MS - 1, "fix"))).toBe("active");
    expect(g(dwell(FIX_STUCK_MS, "fix"))).toBe("problem");
  });
  test("未知 / 近似起点不算", () => {
    expect(g(dwell(10 * FIX_STUCK_MS, "fix", { stageSinceApprox: true }))).toBe("active");
    expect(g(base({ stage: "fix", stageSince: null }))).toBe("active");
  });
  test("冻结 fix 不单因停留变红", () => expect(g(dwell(10 * FIX_STUCK_MS, "fix", { frozen: true }))).toBe("queued"));
  test("正常返工 30 分钟以上不误报（fix 不在等待阶段）", () => expect(g(dwell(STUCK_MS + 1, "fix"))).toBe("active"));
});

describe("等待阶段 30 分钟边界（严格 > STUCK_MS）", () => {
  test("review / merge / restate 恰好 30 分钟不算、多 1 毫秒算", () => {
    for (const stage of ["review", "merge", "restate"] as const) {
      expect(g(dwell(STUCK_MS, stage))).toBe("active");
      expect(g(dwell(STUCK_MS + 1, stage))).toBe("problem");
    }
  });
  test("build 不按等待算", () => expect(g(dwell(10 * STUCK_MS, "build"))).toBe("active"));
  test("跨实例委托不算等待超时", () => expect(g(dwell(10 * STUCK_MS, "review", { delegated: true }))).toBe("active"));
  test("冻结不因等待时长变红", () => expect(g(dwell(10 * STUCK_MS, "review", { frozen: true }))).toBe("queued"));
  test("近似起点不猜", () => expect(g(dwell(10 * STUCK_MS, "review", { stageSinceApprox: true }))).toBe("active"));
  test("观察期截止前能用、到点即超时（不再等 30 分钟）", () => {
    const live = (until: number) => base({ stage: "live", stageSince: NOW - 9 * 60 * MIN, observationUntil: until });
    expect(g(live(NOW + 1))).toBe("usable");
    expect(g(live(NOW))).toBe("problem");
    expect(actionState(live(NOW - MIN)).since).toBe(NOW - MIN);
  });
  test("冻结的 live 到点也不变红", () => expect(g(base({ stage: "live", observationUntil: NOW - MIN, frozen: true }))).toBe("usable"));
  test("blocked 硬故障例外：委托 / 冻结都不压", () => {
    expect(g(base({ stage: "blocked", delegated: true }))).toBe("problem");
    expect(actionState(base({ stage: "blocked" })).reason).toBe("受阻");
  });
});

describe("ask：过期 / 已答 / 非 owner 不进要你做", () => {
  const cases: [string, ActionAsk][] = [
    ["过期", ask({ expiresAt: NOW })],
    ["已答", ask({ state: "answered" })],
    ["已取消", ask({ state: "cancelled" })],
    ["非 owner（PM / 执行者收件）", ask({ forOwner: false })],
  ];
  for (const [name, a] of cases) {
    test(name, () => {
      const s = actionState(base({ asks: [a] }));
      expect([s.group, s.waitingOn, s.actions]).toEqual(["active", "none", []]);
    });
  }
  test("授权 / 权限 ask 给批、其它给答；since 取最早的 ask", () => {
    const s = actionState(base({ asks: [ask({ id: "a", createdAt: NOW - 9 * MIN }), ask({ id: "b", kind: "authorize", createdAt: NOW - MIN })] }));
    expect(s.actions).toEqual([{ kind: "answer", askId: "a" }, { kind: "approve", askId: "b" }]);
    expect(s.since).toBe(NOW - 9 * MIN);
  });
});

describe("心跳：unknown / stale / disconnected", () => {
  test("没有心跳记录：在跑的卡 health=unknown，不判断联、不当正常，也不进出问题", () => {
    const s = actionState(base({ heartbeat: null }));
    expect([s.group, s.health]).toEqual(["active", "unknown"]);
  });
  test("没在跑的卡没有心跳记录：normal", () => {
    for (const stage of ["spec", "live", "done"] as const) expect(actionState(base({ stage, heartbeat: null })).health).toBe("normal");
  });
  test("stale / disconnected 是出问题，原因起点取心跳时刻", () => {
    const st = actionState(base({ heartbeat: { state: "stale", at: NOW - 7 * MIN } }));
    expect([st.group, st.health, st.since]).toEqual(["problem", "stale", NOW - 7 * MIN]);
    const dc = actionState(base({ heartbeat: { state: "disconnected", at: NOW - 2 * MIN } }));
    expect([dc.group, dc.health]).toEqual(["problem", "disconnected"]);
  });
});

describe("CI：当前 head 连续三败才算反复失败", () => {
  const ci = (failStreak: number) => ({ phase: "ready", head: HEAD, failStreak, since: NOW - MIN });
  test("两败（含一次红后正常返工）在做、三败出问题", () => {
    expect(g(base({ stage: "fix", ci: ci(1) }))).toBe("active");
    expect(g(base({ stage: "merge", ci: ci(CI_REPEAT_FAILS - 1) }))).toBe("active");
    const s = actionState(base({ stage: "merge", ci: ci(CI_REPEAT_FAILS) }));
    expect([s.group, s.health]).toEqual(["problem", "failed"]);
    expect(s.ci).toEqual({ phase: "ready", head: HEAD, failStreak: 3 });
  });
  test("等 CI：在做、waitingOn=ci", () => {
    const s = actionState(base({ stage: "merge", mergePhase: "await_ci", ci: { phase: "await_ci", head: HEAD, failStreak: 0, since: NOW - 2 * MIN } }));
    expect([s.group, s.waitingOn, s.reason, s.since]).toEqual(["active", "ci", "等 CI", NOW - 2 * MIN]);
  });
});

describe("字段与动作", () => {
  test("waitingOn：review / dependency / peer / none", () => {
    expect(actionState(base({ stage: "review" })).waitingOn).toBe("review");
    expect(actionState(base({ blockedBy: ["a"] })).waitingOn).toBe("dependency");
    expect(actionState(base({ delegated: true })).waitingOn).toBe("peer");
    expect(actionState(base()).waitingOn).toBe("none");
  });
  test("未建卡的待做行：排队，缺规格 / 被挡 / 未开工；没有动作", () => {
    const row = (blockedBy: string[], specReady: boolean) => actionState(base({ taskId: null, stage: null, heartbeat: null, placement: null, blockedBy, specReady, canPause: true }));
    expect([row([], false).group, row([], false).reason]).toEqual(["queued", "缺规格"]);
    expect(row(["n1"], true).waitingOn).toBe("dependency");
    expect([row([], true).reason, row([], true).actions, row([], true).health, row([], true).flow]).toEqual(["未开工", [], "normal", "spec"]);
  });
  test("暂停 / 恢复只在有通道时给，停留在稳定引用", () => {
    expect(actionState(base({ canPause: true })).actions).toEqual([{ kind: "pause", taskId: "t1" }]);
    expect(actionState(base({ canPause: false })).actions).toEqual([]);
    expect(actionState(base({ paused: true })).actions).toEqual([{ kind: "resume", taskId: "t1" }]);
    expect(actionState(base({ stage: "merge", canPause: true })).actions).toEqual([]);
  });
  test("instance / placement 原样带；没有 eta", () => {
    const s = actionState(base({ instance: "w-1", placement: { where: "peer", peer: "Sekai", family: "codex" } }));
    expect([s.instance, s.placement]).toEqual(["w-1", { where: "peer", peer: "Sekai", family: "codex" }]);
    expect("eta" in s).toBe(false);
    expect(actionState(base()).instance).toBeNull();
  });
  test("纯：不改输入，同输入同输出", () => {
    const input = base({ asks: [ask()], blockedBy: ["x"], ci: { phase: "ready", head: HEAD, failStreak: 1, since: 1 } });
    const snap = JSON.stringify(input);
    const a = actionState(input), b = actionState(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snap);
    a.actions.push({ kind: "pause" });
    expect(actionState(input).actions).toHaveLength(1);
  });
});
