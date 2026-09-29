/**
 * 协作视图首页纯逻辑（web/features/collab/collab-model.ts、collab-action.ts）：排序、停留时长、卡住判定、一句话状态、此刻动作。
 */
import { describe, expect, test } from "bun:test";
import { dwellMs, dwellText, fmtDuration, homeView, isStuck, STUCK_MS, type LedgerOverview, type LedgerTaskView, type Stage } from "../web/features/collab/collab-model";

const MIN = 60_000;
const NOW = new Date(2026, 8, 28, 18, 0).getTime();

function task(id: string, stage: Stage, over: Partial<LedgerTaskView> = {}): LedgerTaskView {
  return {
    id, itemId: null, title: `任务 ${id}`, kind: "code", stage, stageBefore: null, round: 0,
    agent: `agent-task-${id.toLowerCase()}`, pm: "agent-pm", pr: null, spec: null, model: null, extra: {},
    createdAt: NOW - 120 * MIN, updatedAt: NOW - MIN, lastEvent: null, stageSince: NOW - 5 * MIN, lastReview: null,
    metrics: { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 },
    ...over,
  };
}

function overview(tasks: LedgerTaskView[], over: Partial<LedgerOverview> = {}): LedgerOverview {
  return { exists: true, now: NOW, meta: { pms: ["agent-pm"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks, ...over };
}

describe("停留时长与卡住", () => {
  test("stageSince 优先；老 bridge 没有时退到最后一条推到当前阶段的 stage 事件；都没有为 null", () => {
    expect(dwellMs(task("A", "build", { stageSince: NOW - 7 * MIN }), NOW)).toBe(7 * MIN);
    const ev = { seq: 1, ts: NOW - 3 * MIN, actor: "x", target: "B", kind: "stage", text: "", data: { from: "restate", to: "build" } };
    expect(dwellMs(task("B", "build", { stageSince: undefined, lastEvent: ev }), NOW)).toBe(3 * MIN);
    expect(dwellMs(task("C", "review", { stageSince: undefined, lastEvent: ev }), NOW)).toBeNull();
  });

  test("只有等待类阶段超过 30 分钟算卡住；开发、返工再久也不算", () => {
    const long = { stageSince: NOW - STUCK_MS - MIN };
    for (const s of ["restate", "review", "merge", "live"] as Stage[]) expect(isStuck(task("X", s, long), NOW)).toBe(true);
    for (const s of ["build", "fix", "spec"] as Stage[]) expect(isStuck(task("X", s, long), NOW)).toBe(false);
    expect(isStuck(task("X", "review", { stageSince: NOW - STUCK_MS }), NOW)).toBe(false);
  });

  test("导入推断的 stageSince 不判卡住，时长前面标 ≈", () => {
    const t = task("A", "review", { stageSince: NOW - 3 * 60 * MIN, stageSinceApprox: true });
    expect(isStuck(t, NOW)).toBe(false);
    const line = homeView(overview([t]), NOW).lines[0];
    expect(line).toMatchObject({ attention: "waiting", dwellApprox: true, reason: "" });
    expect(dwellText(line)).toBe("在此阶段 ≈3小时");
    expect(dwellText({ dwellMs: 5 * MIN, dwellApprox: false })).toBe("在此阶段 5分");
    expect(dwellText({ dwellMs: null, dwellApprox: false })).toBe("");
  });

  test("fmtDuration：分 / 小时分 / 整小时 / 不到 1 分", () => {
    expect([fmtDuration(30_000), fmtDuration(42 * MIN), fmtDuration(91 * MIN), fmtDuration(120 * MIN)]).toEqual(["不到 1分", "42分", "1小时31分", "2小时"]);
  });
});

describe("首页排序与一句话状态", () => {
  const tasks = [
    task("P", "build", { stageSince: NOW - 80 * MIN }),
    task("W", "review", { round: 2, stageSince: NOW - 7 * MIN }),
    task("M1", "merge", { stageSince: NOW - 42 * MIN }),
    task("M2", "merge", { stageSince: NOW - 10 * MIN }),
    task("F", "fix", { round: 1, stageSince: NOW - 3 * MIN, lastReview: { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 1, text: "位置没恢复\n第二行", ts: NOW - 4 * MIN } }),
    task("Q", "spec", { agent: null }),
    task("D1", "done", { metrics: { ...task("x", "done").metrics, endTs: NOW - 60 * MIN } }),
    task("D0", "verified", { metrics: { ...task("x", "done").metrics, endTs: NOW - 26 * 60 * MIN } }),
    task("X", "cancelled"),
  ];
  const v = homeView(overview(tasks), NOW);

  test("出问题 → 卡住 → 等别人 → 进行中；没派人的 spec、已完成、已取消不画成线", () => {
    expect(v.lines.map((l) => [l.id, l.attention])).toEqual([["F", "problem"], ["M1", "stuck"], ["M2", "waiting"], ["W", "waiting"], ["P", "progress"]]);
  });

  test("阶段短语、原因、合并队列按进入先后排位", () => {
    const by = new Map(v.lines.map((l) => [l.id, l]));
    expect(by.get("F")!).toMatchObject({ stageLabel: "返工中 · 第 1 轮意见", reason: "位置没恢复", tone: "red", column: 3, agent: "task-f" });
    expect(by.get("M1")!).toMatchObject({ stageLabel: "等合并 · 队列第 1 位", reason: "已经等了 42分，超过 30 分钟", stuck: true });
    expect(by.get("M2")!.stageLabel).toBe("等合并 · 队列第 2 位");
    expect(by.get("W")!.stageLabel).toBe("等审查 · 第 2 轮");
    expect(by.get("P")!).toMatchObject({ stageLabel: "开发中", reason: "", tone: "neutral" });
  });

  test("一句话状态计数；今日完成只算本地今天结束的；PM 条的排队", () => {
    expect(v.headline).toEqual({ advancing: 5, problem: 1, stuck: 1, owner: 0 });
    expect(v.todayDone).toEqual(["D1"]);
    expect(v.pm).toMatchObject({ pm: "pm", reviewing: 1, queued: ["Q"], frozen: null });
  });

  test("合并队列冻结时写冻结，卡住原因带上冻结理由", () => {
    const fz = homeView(overview([task("M", "merge", { stageSince: NOW - 40 * MIN })], { meta: { pms: [], docsDir: null, queueFrozen: { frozen: true, reason: "等 T1 上线", since: 0 } } }), NOW);
    expect(fz.lines[0]).toMatchObject({ stageLabel: "合并队列冻结", reason: "已经等了 40分，超过 30 分钟（冻结：等 T1 上线）" });
    expect(fz.pm.frozen).toBe("等 T1 上线");
  });

  test("一句目标：extra.goal → 事项 oneLine → 空", () => {
    const ov = overview([task("G", "build", { extra: { goal: " 目标句 " }, itemId: "i1" }), task("H", "build", { itemId: "i1" }), task("K", "build")], {
      items: [{ id: "i1", title: "事项", oneLine: "事项一句话" }],
    });
    expect(homeView(ov, NOW).lines.map((l) => [l.id, l.goal])).toEqual([["G", "目标句"], ["H", "事项一句话"], ["K", ""]]);
  });

  test("验证失败、回滚算出问题；受阻落在进入受阻前的那一列", () => {
    const ev = (kind: string, data: Record<string, unknown>) => ({ seq: 1, ts: NOW, actor: "a", target: "", kind, text: "", data });
    const ov = overview([
      task("V", "live", { lastEvent: ev("verify", { result: "fail" }) }),
      task("R", "live", { lastEvent: ev("rollback", {}) }),
      task("U", "live", { lastEvent: ev("verify", { result: "unknown" }) }),
      task("P", "live", { lastEvent: ev("verify", { result: "pass" }) }),
      task("B", "blocked", { stageBefore: "review", lastEvent: { ...ev("stage", { to: "blocked" }), text: "等上游修复" } }),
    ]);
    const lines = new Map(homeView(ov, NOW).lines.map((l) => [l.id, l]));
    expect(lines.get("V")!).toMatchObject({ attention: "problem", stageLabel: "线上验证失败" });
    expect(lines.get("R")!.attention).toBe("problem");
    expect(lines.get("U")!).toMatchObject({ attention: "problem", stageLabel: "线上验证查不到结果" }); // 检查单有项查不到：卡在 live，要人看
    expect(lines.get("P")!.stageLabel).toBe("已上线 · 等验证");
    expect(lines.get("B")!).toMatchObject({ attention: "problem", column: 3, reason: "等上游修复" });
  });

  test("空台账：没有线、计数全 0", () => {
    expect(homeView(overview([], { exists: false }), NOW)).toMatchObject({ lines: [], todayDone: [], headline: { advancing: 0, problem: 0, stuck: 0 } });
  });
});

describe("等你（T11a：features/asks 的开着的 ask 喂进来）", () => {
  const wait = (id: string, taskId: string | null, fromAgent: string, title = "发不发") => ({ id, taskId, fromAgent, title });

  test("挂在任务上的、或执行者发的没挂任务的 ask → 这条线归「等你」，排在出问题之后、卡住之前，原因是 ask 标题", () => {
    const tasks = [
      task("P", "fix"),
      task("S", "review", { stageSince: NOW - STUCK_MS - MIN }),
      task("O", "build"),
      task("A", "build"),
    ];
    const v = homeView(overview(tasks), NOW, undefined, [wait("ask_1", "O", "agent-other", "要不要打 tag"), wait("ask_2", null, "agent-task-a")]);
    expect(v.lines.map((l) => [l.id, l.attention])).toEqual([["P", "problem"], ["A", "owner"], ["O", "owner"], ["S", "stuck"]]);
    expect(v.lines.find((l) => l.id === "O")).toMatchObject({ tone: "amber", reason: "等你：要不要打 tag" });
    expect(v.headline.owner).toBe(2);
  });

  test("出问题的线不被「等你」盖掉；没有 ask 时和原来一样", () => {
    const v = homeView(overview([task("P", "fix")]), NOW, undefined, [wait("ask_1", "P", "agent-task-p")]);
    expect(v.lines[0].attention).toBe("problem");
    expect(homeView(overview([task("B", "build")]), NOW).headline.owner).toBe(0);
    // 标题栏数的是归到「等你」的线：挂不到线上的 ask（别的 agent 发的）不算，和各条线对得上
    expect(homeView(overview([task("B", "build")]), NOW, undefined, [wait("ask_9", null, "agent-other")]).headline.owner).toBe(0);
  });
});

describe("跨实例委托（extra.delegate）", () => {
  test("没有本机执行者时显示委托对象；spec 阶段也画成线、不算 PM 排队", () => {
    const d = { agent: null, extra: { delegate: "claudestra@Shawn" } };
    const v = homeView(overview([task("D1", "build", d), task("D2", "spec", d), task("Q", "spec", { agent: null })]), NOW);
    expect(v.lines.map((l) => [l.id, l.agent, l.delegate]).sort()).toEqual([["D1", null, "claudestra@Shawn"], ["D2", null, "claudestra@Shawn"]]);
    expect(v.lines.find((l) => l.id === "D2")?.stageLabel).toBe("等开工");
    expect(v.pm.queued).toEqual(["Q"]);
  });

  test("委托任务停多久都不算卡住", () => {
    expect(isStuck(task("D", "review", { agent: null, extra: { delegate: "x@Y" }, stageSince: NOW - 10 * STUCK_MS }), NOW)).toBe(false);
  });

  test("有本机执行者时不看 extra.delegate", () => {
    const line = homeView(overview([task("L", "build", { extra: { delegate: "x@Y" } })]), NOW).lines[0];
    expect([line.agent, line.delegate]).toEqual(["task-l", null]);
  });
});
