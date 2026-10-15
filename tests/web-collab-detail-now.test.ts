/**
 * team-project-UXCARD1：任务详情「现在」一句话（detail-now-model.ts）。八个阶段各一例；名字 / 轮次 / 时长缺失时整段不写；
 * 别的机器为主场的卡写成员代号 +「在 <机器名>」，不出长十六进制；下一步归谁按规格第 1 条；标题灰字、阶段格时长、叫停出现条件。
 */
import { expect, test } from "bun:test";
import {
  awaySayText, detailGoal, nowFactsOf, nowSentence, runningReviewerOf, staleText, stageTimes, stopTarget, type NowFacts,
} from "../web/features/collab/detail-now-model";
import type { LedgerEventView, LedgerTaskView, LineView, Stage } from "../web/features/collab/collab-model";
import type { RunningReviewer } from "../web/features/collab/collab-reviewers";
import type { TaskWorkFacts } from "../web/features/collab/work/task-work-facts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HEX = "a1b2c3d4e5f60718293a4b5c";
const facts = (p: Partial<NowFacts>): NowFacts => ({
  stage: "build", round: 1, executor: "dev", pm: "claudestra", reviewer: null, dwellMs: 23 * MIN, reason: "", now: NOW, awayMachine: null, ...p,
});
const BAD = /未知|第 0 轮|0分|不到 1分|undefined|null|NaN/;
const facts0 = (p: Partial<TaskWorkFacts>): TaskWorkFacts => ({
  column: "working", who: "agent-dev", lent: false, machine: null, family: null, step: "write", round: null, since: null, reason: null, code: null, stage: null, team: false, ...p,
});

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

test("[验收线 5] 叫停出现条件（UXCARD3 起读快照）：主场本机 + 快照在干活 + 不是出借 + 没过期 + 执行者在线 + 卡没结束", () => {
  const w = facts0({ column: "working", who: "agent-dev" });
  const on = (a: string) => a === "dev";
  const stop = (p: Partial<Parameters<typeof stopTarget>[0]>) => stopTarget({ homeLocal: true, work: w, homeRead: false, stage: "build", online: on, ...p });
  expect(stop({})).toBe("dev");
  expect(stop({ homeLocal: false })).toBeNull();
  expect(stop({ online: () => false })).toBeNull();
  for (const stage of ["done", "verified", "cancelled"] as Stage[]) expect(stop({ stage })).toBeNull();
});

test("[验收线 6] 别的机器为主场「对它说」写机器名和原因；名字像 id 时写其他成员的机器", () => {
  expect(awaySayText("alice-mac")).toBe("这张卡在 alice-mac 上执行，对它说要那台机器授权，暂不支持");
  expect(awaySayText(HEX)).toBe("这张卡在 其他成员的机器 上执行，对它说要那台机器授权，暂不支持");
  expect(awaySayText(null)).not.toMatch(/[0-9a-f]{16,}/i);
});

// ———— followup-reliability-UXCARD3：句子取「谁在干活」快照 ————
const LENT = facts0({ who: "peer:alice · codex", lent: true, machine: "alice", family: "codex" });

test("[验收线 4] 快照在干活：本机写 / 修 / 审、出借写 / 审；时长从快照开始时刻算，轮次用快照的", () => {
  const at = NOW - 23 * MIN;
  const cases: [Partial<NowFacts>, TaskWorkFacts, string, string][] = [
    [{ stage: "build", executor: "placeholder" }, facts0({ step: "write", since: at }), "执行者 dev 在写 · 已 23分", "下一步：执行者送审"],
    [{ stage: "fix", round: 5 }, facts0({ step: "fix", round: 2, since: at }), "执行者 dev 在改第 2 轮意见 · 已 23分", "下一步：执行者改完再送审"],
    [{ stage: "review" }, facts0({ who: "agent-rv-x", step: "review", round: 3, since: at }), "审查员 rv-x 在审第 3 轮 · 已 23分", "下一步：审查员给结论（通过进合并，不通过回执行者）"],
    [{ stage: "build", executor: "placeholder" }, { ...LENT, step: "write", since: at }, "alice 上的 codex 在写 · 已 23分", "下一步：执行者送审"],
    [{ stage: "review" }, { ...LENT, step: "review", round: 1, since: at }, "alice 上的 codex 在审第 1 轮 · 已 23分", "下一步：审查员给结论（通过进合并，不通过回执行者）"],
    [{ stage: "build" }, { ...LENT, family: null, step: "write", since: at }, "alice 上的执行者 在写 · 已 23分", "下一步：执行者送审"],
    [{ stage: "restate" }, facts0({ step: "restate", since: at }), "执行者 dev 在复述 · 已 23分", "下一步：PM 放行后执行者开写"],
    [{ stage: "build" }, facts0({ step: "publishing", since: at }), "执行者 dev 在交付 · 已 23分", "下一步：执行者送审"],
    [{ stage: "merge" }, facts0({ step: "deploy", since: at }), "已合并，在部署 · 已 23分", "下一步：合并后上线"],
  ];
  for (const [p, work, who, next] of cases) {
    const s = nowSentence(facts({ ...p, work }));
    expect(s.who).toBe(who);
    expect(s.next).toBe(next);
    expect(s.usedReason).toBe(true);
  }
  // 出借审查不写「等审查员领单」
  expect(nowSentence(facts({ stage: "review", reviewer: null, work: { ...LENT, step: "review", round: 1, since: at } })).who).not.toContain("等审查员领单");
});

test("[验收线 4] 快照在等 / 在等合并 / 老卡：原因 · 已等 时长；manual 下一步归 PM；退回人工不出「在改第 N 轮」；老卡不出时长", () => {
  const at = NOW - 90 * MIN;
  const manual = nowSentence(facts({ stage: "fix", round: 5, work: facts0({ column: "waiting", step: "fix", code: "manual", reason: "退回人工（manual）：缺凭据", since: at }) }));
  expect(manual).toEqual({ who: "退回人工（manual）：缺凭据 · 已等 1小时30分", next: "下一步：PM 接手", usedReason: true });
  expect(manual.who).not.toMatch(/在改第 \d+ 轮/);
  const pooled = nowSentence(facts({ stage: "review", work: facts0({ column: "waiting", step: "review", code: "pooled", reason: "等审查员领单", since: at }) }));
  expect(pooled).toEqual({ who: "等审查员领单 · 已等 1小时30分", next: "下一步：审查员给结论（通过进合并，不通过回执行者）", usedReason: true });
  const ask = nowSentence(facts({ stage: "build", work: facts0({ column: "waiting", code: "ask", reason: "等 owner", since: at }) }));
  expect(ask).toEqual({ who: "等 owner · 已等 1小时30分", next: "下一步：执行者送审", usedReason: true });
  const queue = nowSentence(facts({ stage: "merge", work: facts0({ column: "merging", code: "merge_queue", reason: "合并排队：前面是 X9", since: at }) }));
  expect(queue).toEqual({ who: "合并排队：前面是 X9 · 已等 1小时30分", next: "下一步：合并后上线", usedReason: true });
  for (const code of ["quota", "executor_missing"]) {
    expect(nowSentence(facts({ stage: "build", work: facts0({ column: "waiting", code, reason: "x", since: at }) })).next).toBe("下一步：PM 接手");
  }
  // 团队行（别的机器为主场）在等、快照没写原因：句子按阶段，卡的镜像提示（阻塞提问 / 过期）照旧另起一行
  const away = nowSentence(facts({ stage: "review", awayMachine: "alice-mac", dwellMs: null, work: facts0({ column: "waiting", team: true, who: "peer-dev" }) }));
  expect(away).toEqual({ who: "等审查员领单 · 在 alice-mac", next: "下一步：审查员给结论（通过进合并，不通过回执行者）", usedReason: false });
  const old = nowSentence(facts({ stage: "review", dwellMs: 336 * 60 * MIN, work: facts0({ column: "legacy", who: null, step: null, stage: "review" }) }));
  expect(old).toEqual({ who: "老卡（没有调度记录）· 停在审查，调度器不派活", next: "下一步：PM 收尾或补调度记录", usedReason: true });
  expect(old.who).not.toMatch(/已等|超过 30 分钟|\d+分/);
});

test("[验收线 4] 快照没有这张卡（null / 不给）：输出和旧逻辑逐字一致；暂停态仍优先", () => {
  for (const stage of ["build", "review", "fix", "merge"] as Stage[]) {
    expect(nowSentence(facts({ stage, work: null }))).toEqual(nowSentence(facts({ stage })));
  }
  const pause = { mode: "on", paused: true, actor: "owner", at: NOW - 5 * MIN, reason: "看一下" } as unknown as NowFacts["pause"];
  expect(nowSentence(facts({ pause, work: facts0({ since: NOW }) })).who).toContain("已暂停");
});

test("[验收线 1] 叫停可见性：出借 / 退回人工（在等）/ 老卡 / 过期 / 快照没到 → 不出；本机在干活且在线 → 打到快照里的执行者", () => {
  const base = { homeLocal: true, homeRead: false, stage: "build" as Stage, online: () => true };
  expect(stopTarget({ ...base, work: { ...LENT, who: "peer:alice · codex" } })).toBeNull();
  expect(stopTarget({ ...base, work: facts0({ who: "dev@alice-mac", lent: true }) })).toBeNull();
  expect(stopTarget({ ...base, stage: "fix", work: facts0({ column: "waiting", code: "manual" }) })).toBeNull();
  expect(stopTarget({ ...base, stage: "review", work: facts0({ column: "legacy", who: null }) })).toBeNull();
  expect(stopTarget({ ...base, homeRead: true, work: facts0({}) })).toBeNull();
  expect(stopTarget({ ...base, work: undefined })).toBeNull();
  expect(stopTarget({ ...base, work: null })).toBeNull();
  expect(stopTarget({ ...base, work: facts0({ who: "agent-dev-2" }) })).toBe("dev-2");
});

test("过期一行写本机详情最后读到的时:分", () => {
  const at = new Date(2026, 9, 14, 9, 5).getTime();
  expect(staleText(at)).toBe("数据可能过期（本机详情最后读到 09:05）");
});
