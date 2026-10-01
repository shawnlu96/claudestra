/**
 * 总览瘦身（i28-V1h）：夹具按 10-02 生产台账的结构造——28 个事项各带 ~1KB extra / ~0.5KB next，32 张在跑卡带真实体量的步骤线
 * 与多行事件，186 张已完成卡（其中 15 张今天完成）。量 GET /ledger/:project 的字节数，并核对网页各视图算出来的东西和改前一致。
 */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { closeLedger, LEDGER_SCHEMA_VERSION, listItems, openLedger } from "../src/lib/ledger-store";
import { appendEvent, createItem, importTask } from "../src/lib/ledger-write";
import { addDep } from "../src/lib/ledger-deps-write";
import { PROJECT_EVENTS_LIMIT, projectView, taskDetail } from "../src/lib/ledger-read";
import { schedulerProjectView } from "../src/lib/ledger-scheduler";
import { homeView, lineOf, type LedgerOverview, type LedgerTaskView, type LineView } from "../web/features/collab/collab-model";
import { stepLineView } from "../web/features/collab/collab-step-line-model";
import { metricsOf, mobileSections, outlineOf, stageCounts } from "../web/features/collab/v4/v4-model";
import { causalCanvas } from "../web/features/collab/v4/causal-model";

/** 本地正午：「今天」按跑测试这台机器的零点算，和服务端（bridge 本机）同一口径 */
const NOW = new Date(2026, 9, 2, 12).getTime();
const MIDNIGHT = new Date(2026, 9, 2).getTime();
const MIN = 60_000;
const LIVE = 32, DONE = 186, DONE_TODAY = 15;
const LIVE_STAGES = ["build", "review", "fix", "merge", "live", "spec"] as const;
const DONE_STAGES = ["verified", "done", "cancelled"] as const;
const GLOBS = ["src/lib/ledger-read.ts", "tests/ledger-read*.test.ts", "tests/web-collab-*.test.ts", "web/features/collab/**", "web/lib/api/ledger.ts"];
const OWNER = { actor: "owner", now: NOW - 5 * 86_400_000 };
const DOT_KEYS = ["derived", "executor", "executorKind", "round", "state", "step"];

afterEach(() => closeLedger(":memory:"));

/** 步骤行直接写表：带 head 区间、结论、本机核验与对方自报，体量和生产里的一行相当 */
function addSteps(db: Database, taskId: string, n: number, rows: [string, number, string, string | null][], at: number): void {
  for (const [step, round, state, verdict] of rows) {
    const peer = step === "review" || step === "final_review";
    db.run(
      `INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, headFrom, headTo, verdict, verified, claims, rev, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [taskId, step, round, peer ? `agent-rv-i28-${n}@Sekai` : `agent-task-i28-${n}`, peer ? "peer" : "agent", state,
        "e88bf46f96287127140c69978975bac6d04deca8", "f911e99f0a1b2c3d4e5f60718293a4b5c6d7e8f9", verdict,
        JSON.stringify(peer ? { reviewerNotAuthor: true, author: `agent-task-i28-${n}` } : {}),
        JSON.stringify(peer ? { model: "gpt-6-astra", effort: "xhigh" } : {}), at, at],
    );
  }
}

function fixture(): Database {
  const db = openLedger(":memory:");
  for (let i = 0; i < 28; i++) {
    createItem(db, OWNER, {
      project: "p", id: `i${i}`, title: `事项 ${i}：协作底座改版的一个方向`, status: "doing", priority: "P1",
      oneLine: "一句话目标：协作视图打开快、看得懂、点得动", ownerWords: "owner 原话：".repeat(18), next: "下一步安排说明。".repeat(22),
      extra: { notes: "事项背景与拆分说明。".repeat(36) },
    });
  }
  for (let n = 0; n < LIVE + DONE; n++) {
    const live = n < LIVE;
    const id = live ? `l${n}` : `d${n - LIVE}`;
    const k = n - LIVE;
    const stage = live ? LIVE_STAGES[n % LIVE_STAGES.length] : DONE_STAGES[k % DONE_STAGES.length];
    // 已完成卡的完成时刻：前 15 张今天，第 16 张昨天最后一分钟（之后补的 note 把 updatedAt 推过零点），其余往前铺
    const end = live ? NOW - (n + 1) * 7 * MIN : k < DONE_TODAY ? MIDNIGHT + (k + 1) * 20 * MIN : MIDNIGHT - (k - DONE_TODAY + 1) * 37 * MIN + 36 * MIN;
    const initialStage = stage === "spec" ? "spec" : "review";
    const events = [
      { kind: "review" as const, ts: end - 30 * MIN, text: `第 1 轮审查：P1 两处、P2 三处，详见报告\n${"细节".repeat(30)}`, data: { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 3 } },
      ...(stage === initialStage || stage === "review" ? [] : [{ kind: "stage" as const, ts: end, data: { from: initialStage, to: stage } }]),
      { kind: "note" as const, ts: end + 4 * MIN, text: `执行者回报：${"进展说明。".repeat(5)}\n${"第二行细节。".repeat(10)}\n第三行`, data: { proof: "证据".repeat(20) } },
    ];
    importTask(db, OWNER, {
      createdTs: end - 3 * 3_600_000, initialStage, events: stage === "spec" ? events.filter((e) => e.kind === "note") : events,
      task: {
        project: "p", id, itemId: `i${n % 28}`, stage, title: `i28-${n} 协作底座改版：一张卡的标题大约三十个汉字那么长`, kind: n % 7 === 0 ? "ops" : "code",
        agent: `agent-task-i28-${n}`, pm: "agent-claudestra", pr: `https://github.com/shawnlu96/claudestra/pull/${300 + n}`,
        extra: { goal: "目标句：说清这张卡做完以后用户能做什么。", fileGlobs: GLOBS, repo: "shawnlu96/claudestra", ...(live ? {} : { notes: "交付备注。".repeat(40) }) },
      },
    });
    db.run("UPDATE tasks SET updatedAt = ? WHERE id = ?", [end + 4 * MIN, id]);
    const rows: [string, number, string, string | null][] = live
      ? [["write", 0, "done", null], ["review", 1, "done", "changes"], ["fix", 1, "assigned", null]]
      : [["write", 0, "done", null], ["review", 1, "done", "changes"], ["fix", 1, "done", null], ["final_review", 2, "done", "pass"], ["merge", 0, "done", null]];
    if (stage !== "spec") addSteps(db, id, n, rows, end - 60 * MIN);
  }
  for (let k = 0; k < 32; k++) addDep(db, OWNER, { from: `d${k}`, to: `l${k}`, when: "前置合并上线后再开工" });
  for (let k = 0; k < PROJECT_EVENTS_LIMIT + 5; k++) appendEvent(db, OWNER, { project: "p", target: "", kind: "note", text: `PM 记录 ${k}：${"项目级说明。".repeat(12)}` });
  return db;
}

const bytes = (value: object) => Buffer.byteLength(JSON.stringify({
  ok: true, exists: true, project: "p", schema: LEDGER_SCHEMA_VERSION, projectEventsLimit: PROJECT_EVENTS_LIMIT, now: NOW, ...value,
}));
const wire = (value: object) => JSON.parse(JSON.stringify({ exists: true, now: NOW, ...value })) as LedgerOverview;
/** 列表小圆点看到的东西（collab-step-line.tsx StepDots）：每格有没有人、状态、是不是当前、接手人，加等待徽标 */
const dots = (line: unknown, stage: string) => {
  const v = stepLineView(line, stage);
  return v && { wait: v.wait, slots: v.slots.map((s) => [s.key, s.filled, s.state, s.current, s.executor, s.instance, s.kind]) };
};
const plain = ({ stepLine, ...rest }: LineView) => ({ ...rest, dots: dots(stepLine, rest.stage) });

test("生产结构的 218 张卡：总览 ≤150KB（改前 >600KB），scheduler 段与网页不读的字段都不发", () => {
  const db = fixture();
  const view = projectView(db, "p", NOW);
  const before = {
    ...view, scheduler: schedulerProjectView(db, "p"), items: listItems(db, "p"),
    tasks: view.tasks.map((t) => ({ ...taskDetail(db, "p", t.id, NOW)!.task, stepLine: taskDetail(db, "p", t.id, NOW)!.stepLine })),
  };
  console.log(`${LIVE + DONE} cards: before=${bytes(before)} after=${bytes(view)} bytes`);
  expect(bytes(before)).toBeGreaterThan(600_000);
  expect(bytes(view)).toBeLessThanOrEqual(150_000);
  expect("scheduler" in view).toBe(false);
  expect(view.items.every((i) => Object.keys(i).sort().join() === "id,oneLine,title")).toBe(true);
  for (const t of view.tasks) {
    const done = DONE_STAGES.includes(t.stage as (typeof DONE_STAGES)[number]);
    const today = done && (t.metrics.endTs ?? t.updatedAt) >= MIDNIGHT;
    for (const s of t.stepLine?.steps ?? []) expect(DOT_KEYS).toEqual(expect.arrayContaining(Object.keys(s)));
    if (!done) expect(Object.keys(t.extra ?? {}).sort()).toEqual(["goal"]);
    else for (const key of ["extra", "lastReview", "stageBefore", "assignee", "spec", "createdAt"]) expect(t).not.toHaveProperty(key);
    if (done && !today) for (const key of ["stepLine", "lastEvent", "stageSinceApprox"]) expect(t).not.toHaveProperty(key);
    if (today && t.stage !== "spec") expect(t.stepLine?.steps.length).toBe(5);
  }
});

test("首页、指标、大纲、因果画布、手机列表（含今日完成的小圆点）和改前算出来一样；详情仍是全量", () => {
  const db = fixture();
  const view = projectView(db, "p", NOW);
  const details = new Map(view.tasks.map((t) => [t.id, taskDetail(db, "p", t.id, NOW)!]));
  const full = wire({ ...view, items: listItems(db, "p"), tasks: view.tasks.map((t) => ({ ...details.get(t.id)!.task, stepLine: details.get(t.id)!.stepLine })) });
  const slim = wire(view);

  const [hf, hs] = [homeView(full, NOW), homeView(slim, NOW)];
  expect(hs.lines.map(plain)).toEqual(hf.lines.map(plain));
  expect({ ...hs, lines: [] }).toEqual({ ...hf, lines: [] });
  expect(hs.todayDone.length).toBeGreaterThan(0);
  expect(hs.todayDone).not.toContain(`d${DONE_TODAY}`); // 昨天完成、今天补了 note：不算今日完成
  expect(metricsOf(slim, hs.todayDone.length, 3)).toEqual(metricsOf(full, hf.todayDone.length, 3));
  expect(stageCounts(slim)).toEqual(stageCounts(full));
  for (const f of ["all", "runnable", "waiting", "done", "p0"] as const) {
    const ids = (ov: LedgerOverview) => outlineOf(ov, f).map((g) => [g.id, g.title, g.tasks.map((t) => [t.id, t.title, t.stage])]);
    expect(ids(slim)).toEqual(ids(full));
  }
  const geo = (ov: LedgerOverview) => {
    const c = causalCanvas(ov);
    const nodes = c.groups.map((g) => [g.id, g.done, g.folds, g.nodes.map(({ task, ...n }) => [n, task.title, task.stage, task.stageBefore ?? null, task.kind])]);
    return { nodes, edges: c.edges.map((e) => [e.id, e.label, e.style]) };
  };
  expect(geo(slim)).toEqual(geo(full));

  // 手机列表：今日完成的卡现算一条线（目标句不显示、详情从单卡接口取，不比）
  const card = (ov: LedgerOverview, id: string) => {
    const t = ov.tasks.find((x) => x.id === id)!;
    const { goal: _goal, ...line } = plain(lineOf(t, ov, new Map(ov.items.map((i) => [i.id, i])), NOW));
    return { line, bar: [t.stage, t.stageBefore ?? null, t.kind] };
  };
  expect(mobileSections(slim, hs.todayDone)).toEqual(mobileSections(full, hf.todayDone));
  for (const id of hs.todayDone) expect(card(slim, id)).toEqual(card(full, id));
  expect(hs.todayDone.every((id) => dots(slim.tasks.find((t) => t.id === id)!.stepLine, "done")?.slots.some((s) => s[1]))).toBe(true);

  // 成员（团队栏）、PR → 卡（审查员对号）、标题（「上次以来」）
  const people = (ov: LedgerOverview) => [...new Set(ov.tasks.flatMap((t: LedgerTaskView) => [t.agent, t.pm]).filter(Boolean))].sort();
  expect(people(slim)).toEqual(people(full));
  const prs = (ov: LedgerOverview) => ov.tasks.map((t) => [t.id, t.title, t.pr ?? null]);
  expect(prs(slim)).toEqual(prs(full));

  for (const d of details.values()) {
    expect(d.task.extra.fileGlobs).toEqual(GLOBS);
    if (d.task.stage !== "spec") expect(d.task.metrics.p2).toBeGreaterThan(0);
    if (d.task.stage !== "spec") expect(d.stepLine.steps[0]).toMatchObject({ headTo: expect.any(String) });
    expect(d.events.find((e) => e.kind === "note")?.text).toContain("\n第三行");
  }
});
