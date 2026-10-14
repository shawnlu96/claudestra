/**
 * team-project-UXCARD1：任务详情「现在」一句话（detail-now-model.ts）。八个阶段各一例；名字 / 轮次 / 时长缺失时整段不写；
 * 别的机器为主场的卡写成员代号 +「在 <机器名>」，不出长十六进制；下一步归谁按规格第 1 条；标题灰字、阶段格时长、叫停出现条件。
 */
import { expect, test } from "bun:test";
import {
  awaySayText, canStopRound, detailGoal, nowFactsOf, nowSentence, runningReviewerOf, stageTimes, type NowFacts,
} from "../web/features/collab/detail-now-model";
import type { LedgerEventView, LedgerTaskView, LineView, Stage } from "../web/features/collab/collab-model";
import type { RunningReviewer } from "../web/features/collab/collab-reviewers";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HEX = "a1b2c3d4e5f60718293a4b5c";
const facts = (p: Partial<NowFacts>): NowFacts => ({
  stage: "build", round: 1, executor: "dev", pm: "claudestra", reviewer: null, dwellMs: 23 * MIN, reason: "", now: NOW, awayMachine: null, ...p,
});
const BAD = /未知|第 0 轮|0分|不到 1分|undefined|null|NaN/;

test("[验收线 1] 八个阶段各一例：谁 · 在做什么 · 多久 + 下一步归谁", () => {
  const cases: [Partial<NowFacts>, string, string][] = [
    [{ stage: "build" }, "执行者 dev 在写 · 已 23分", "下一步：执行者送审"],
    [{ stage: "review", round: 2, reviewer: { name: "rv-x", startedAt: NOW - 23 * MIN }, dwellMs: 40 * MIN }, "审查员 rv-x 在审第 2 轮 · 已 23分", "下一步：审查员给结论（通过进合并，不通过回执行者）"],
    [{ stage: "fix", round: 2 }, "执行者 dev 在改第 2 轮意见 · 已 23分", "下一步：执行者改完再送审"],
    [{ stage: "restate" }, "等 PM claudestra 放行 · 已等 23分", "下一步：PM 放行后执行者开写"],
    [{ stage: "merge", reason: "文件锁：collab-detail.tsx" }, "等合并 · 文件锁：collab-detail.tsx · 已等 23分", "下一步：合并后上线"],
    [{ stage: "live" }, "等 PM claudestra 验证 · 已等 23分", "下一步：PM 验证"],
    [{ stage: "blocked", reason: "缺凭据" }, "受阻 · 缺凭据 · 已 23分", "下一步：PM 解除阻塞"],
    [{ stage: "spec" }, "还没开工，等 PM claudestra 派发 · 已等 23分", "下一步：PM 派发"],
  ];
  for (const [p, who, next] of cases) {
    const s = nowSentence(facts(p));
    expect(s.who).toBe(who);
    expect(s.next).toBe(next);
  }
  expect(nowSentence(facts({ stage: "done" }))).toEqual({ who: "已完成", next: null, usedReason: false });
});

test("[验收线 1] 审查没有在跑的审查员：等审查员领单 · 已等 <停留时长>", () => {
  expect(nowSentence(facts({ stage: "review", round: 2 })).who).toBe("等审查员领单 · 已等 23分");
});

test("[验收线 1] 名字 / 轮次 / 时长缺失：不写那一段，不出现「未知」「第 0 轮」「0 分」", () => {
  const stages: Stage[] = ["spec", "restate", "build", "review", "fix", "merge", "live", "blocked"];
  for (const stage of stages) {
    for (const p of [
      { executor: null, pm: null, round: null, dwellMs: null },
      { executor: null, pm: null, round: 0, dwellMs: 0, reviewer: { name: null, startedAt: null } },
      { round: 0, dwellMs: 20_000, reviewer: { name: null, startedAt: NOW } },
    ] as Partial<NowFacts>[]) {
      const s = nowSentence(facts({ stage, ...p }));
      expect(s.who).not.toMatch(BAD);
      expect(s.who).not.toMatch(/ · $|^ · | · {2}/);
    }
  }
  expect(nowSentence(facts({ stage: "build", executor: null, dwellMs: null })).who).toBe("执行者 在写");
  expect(nowSentence(facts({ stage: "review", round: null, reviewer: { name: null, startedAt: null } })).who).toBe("审查员 在审");
  expect(nowSentence(facts({ stage: "fix", round: 0, dwellMs: null })).who).toBe("执行者 dev 在改审查意见");
  expect(nowSentence(facts({ stage: "restate", pm: null, dwellMs: null })).who).toBe("等 PM 放行");
});

test("[验收线 1] 别的机器为主场：成员代号 +「在 <机器名>」，机器名 / 代号像 id 的不出现", () => {
  const s = nowSentence(facts({ stage: "build", executor: "peer-dev", awayMachine: "alice-mac" }));
  expect(s.who).toBe("执行者 peer-dev 在写 · 在 alice-mac · 已 23分");
  const hex = nowSentence(facts({ stage: "merge", executor: HEX, awayMachine: HEX, dwellMs: null }));
  expect(hex.who).toBe("等合并 · 在 其他成员的机器");
  const hexExec = nowSentence(facts({ stage: "fix", executor: HEX, awayMachine: "其他成员的机器" }));
  expect(hexExec.who).toBe("执行者 在改第 1 轮意见 · 在 其他成员的机器 · 已 23分");
  for (const x of [hex, hexExec]) expect(JSON.stringify(x)).not.toMatch(/[0-9a-f]{16,}/i);
});

test("导入推断的停留时长带 ≈；审查员时长从它开始算，不带 ≈", () => {
  expect(nowSentence(facts({ dwellApprox: true })).who).toBe("执行者 dev 在写 · 已 ≈23分");
  const r = nowSentence(facts({ stage: "review", round: 2, dwellApprox: true, reviewer: { name: "rv", startedAt: NOW - 5 * MIN } }));
  expect(r.who).toBe("审查员 rv 在审第 2 轮 · 已 5分");
});

const ev = (seq: number, ts: number, data: Record<string, unknown>): LedgerEventView => ({ seq, ts, actor: "scheduler", target: "T", kind: "scheduler", text: "", data });
const rr = (startedAt: number, round: number | null = 2): RunningReviewer => ({ id: `bg-${startedAt}`, pm: "claudestra", startedAt, taskId: "T", round, adversarial: false });

test("在跑的审查员：PM 子 agent 优先；否则要有进入审查之后派给 / 绑定该审查员会话的事件，上一轮遗留的会话不算", () => {
  const since = NOW - 40 * MIN;
  expect(runningReviewerOf("build", [rr(NOW)], null, [], since)).toBeNull();
  expect(runningReviewerOf("review", [rr(NOW - 9 * MIN), rr(NOW - 3 * MIN)], { agent: "agent-rv-a" }, [], since)).toEqual({ name: null, startedAt: NOW - 9 * MIN });
  const dispatch = ev(1, NOW - 23 * MIN, { op: "plan", action: "review", node: "adversarial_review", recipient: "agent-rv-a" });
  const bind = ev(2, NOW - 30 * MIN, { op: "session_bind", role: "reviewer", agent: "agent-rv-a" });
  expect(runningReviewerOf("review", [], { agent: "agent-rv-a", state: "active" }, [bind, dispatch], since)).toEqual({ name: "rv-a", startedAt: NOW - 23 * MIN });
  const old = ev(3, NOW - 90 * MIN, { op: "plan", action: "review", recipient: "agent-rv-a" });
  expect(runningReviewerOf("review", [], { agent: "agent-rv-a" }, [old], since)).toBeNull();
  expect(runningReviewerOf("review", [], { agent: "agent-rv-a", state: "retired" }, [dispatch], since)).toBeNull();
  expect(runningReviewerOf("review", [], { agent: "agent-rv-a" }, [ev(4, NOW, { op: "plan", action: "review", recipient: "agent-other" })], since)).toBeNull();
});

test("复现测试：复用审查员会话，上一轮绑定早于本阶段，本轮派审是调度器真实的 plan action=review → 算在审，从派审时刻算", () => {
  const since = NOW - 40 * MIN;
  const bind = ev(1, NOW - 90 * MIN, { op: "session_bind", role: "reviewer", agent: "agent-rv" });
  const review = ev(2, NOW - 23 * MIN, { op: "plan", action: "review", node: "adversarial_review", recipient: "agent-rv" });
  expect(runningReviewerOf("review", [], { agent: "agent-rv", state: "active" }, [bind, review], since)).toEqual({ name: "rv", startedAt: NOW - 23 * MIN });
  // 写 / 修单的派单（action=dispatch）发给执行者，不是派审
  const write = ev(3, NOW - 10 * MIN, { op: "plan", action: "dispatch", node: "fix", recipient: "agent-rv" });
  expect(runningReviewerOf("review", [], { agent: "agent-rv" }, [write], since)).toBeNull();
});

const task = (p: Partial<LedgerTaskView>): LedgerTaskView => ({ id: "T", title: "标题", kind: "code", stage: "review", round: 1, updatedAt: NOW, metrics: {}, ...p });
const line = (p: Partial<LineView>): LineView => ({
  id: "T", title: "标题", goal: "", kind: "code", stage: "review", column: 3, attention: "waiting", tone: "amber", stageLabel: "", dwellMs: 23 * MIN,
  dwellApprox: false, stuck: false, reason: "", agent: "dev", delegate: null, pm: "claudestra", round: 1, pr: null, ...p,
});

test("nowFactsOf：返工写最近一轮审查轮次，审查写审查员标题里的轮次，团队不知道轮次不写；别的机器为主场写成员代号", () => {
  const fix = nowFactsOf({ task: task({ stage: "fix", round: 2, lastReview: { round: 3, verdict: "changes", p0: 0, p1: 1, p2: 0, text: "", ts: NOW } }), events: [] },
    line({ stage: "fix" }), [], NOW, null);
  expect(fix.round).toBe(3);
  expect(nowFactsOf({ task: task({ round: 1 }), events: [] }, line({}), [rr(NOW, 4)], NOW, null).round).toBe(4);
  expect(nowFactsOf({ task: task({ round: 0 }), events: [] }, line({}), [], NOW, null).round).toBe(1);
  expect(nowFactsOf({ task: task({ roundUnknown: true }), events: [] }, line({ roundUnknown: true }), [], NOW, null).round).toBeNull();
  const team = { assigneeCode: "peer-dev", executorInstanceId: HEX, head: null, blockingAsks: 0, mirror: null, freshUntil: null };
  const away = nowFactsOf({ task: task({ team }), events: [] }, line({ agent: null }), [], NOW, "alice-mac");
  expect(away.executor).toBe("peer-dev");
  expect(nowFactsOf({ task: task({ team: { ...team, assigneeCode: HEX } }), events: [] }, line({ agent: null }), [], NOW, "alice-mac").executor).toBeNull();
  expect(nowFactsOf({ task: task({}), events: [] }, line({ agent: null, delegate: "dev@peer" }), [], NOW, null).executor).toBe("dev@peer");
});

test("[验收线 2] 标题灰字只写卡自己的目标句；没有 / 与标题相同就不显示", () => {
  expect(detailGoal(task({ extra: { goal: "  让详情一眼看出谁在做  " } }))).toBe("让详情一眼看出谁在做");
  expect(detailGoal(task({ extra: { goal: "标题" } }))).toBeNull();
  expect(detailGoal(task({ extra: { goal: "" } }))).toBeNull();
  expect(detailGoal(task({ itemId: "F1" }))).toBeNull();
  expect(detailGoal(null)).toBeNull();
});

test("[验收线 3] 阶段格时长：全无时整行不写；部分有时没数据的格子留空，不写「—」", () => {
  expect(stageTimes([{ ms: 0 }, { ms: 0 }, { ms: 0 }])).toEqual([null, null, null]);
  const some = stageTimes([{ ms: 0 }, { ms: 5 * MIN }, { ms: 0 }]);
  expect(some).toEqual(["", "5分", ""]);
  expect(some.join("")).not.toContain("—");
});

test("[验收线 5] 叫停出现条件：主场本机 + 执行者在线 + 卡没结束", () => {
  expect(canStopRound({ homeLocal: true, executorOnline: true, stage: "build" })).toBe(true);
  expect(canStopRound({ homeLocal: false, executorOnline: true, stage: "build" })).toBe(false);
  expect(canStopRound({ homeLocal: true, executorOnline: false, stage: "build" })).toBe(false);
  for (const stage of ["done", "verified", "cancelled"] as Stage[]) expect(canStopRound({ homeLocal: true, executorOnline: true, stage })).toBe(false);
});

test("[验收线 6] 别的机器为主场「对它说」写机器名和原因；名字像 id 时写其他成员的机器", () => {
  expect(awaySayText("alice-mac")).toBe("这张卡在 alice-mac 上执行，对它说要那台机器授权，暂不支持");
  expect(awaySayText(HEX)).toBe("这张卡在 其他成员的机器 上执行，对它说要那台机器授权，暂不支持");
  expect(awaySayText(null)).not.toMatch(/[0-9a-f]{16,}/i);
});
