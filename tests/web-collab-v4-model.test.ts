/** 协作视图 v4 的指标条、大纲筛选、手机分组、因果线（web/features/collab/v4/v4-model.ts） */
import { describe, expect, test } from "bun:test";
import type { LedgerDepView, LedgerTaskView, Stage } from "../web/features/collab/collab-model";
import { blockLine, causeOf, edgeBasis, matchFilter, metricsOf, mobileSections, outlineOf, stageCounts } from "../web/features/collab/v4/v4-model";

const metrics = { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 };
function task(id: string, stage: Stage, over: Partial<LedgerTaskView> = {}): LedgerTaskView {
  return { id, itemId: "I1", title: id, kind: "code", stage, stageBefore: null, round: 0, agent: null, pm: null, pr: null, spec: null, model: null, extra: {},
    createdAt: 0, updatedAt: 0, lastEvent: null, metrics, ...over };
}
const dep = (from: string, to: string, over: Partial<LedgerDepView> = {}): LedgerDepView => ({
  from, to, kind: "blocks", when: "合并后", state: null, derived: "waiting", effective: "waiting", createdBy: "agent-pm", createdAt: 0, updatedAt: 0, ...over,
});
const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));

describe("指标条", () => {
  test("进行中不算 ops 和终态；审查轮次累加；P0/P1 修掉只算过了审查的；平均等复核只算此刻在等的", () => {
    const tasks = [
      task("A", "review", { metrics: { ...metrics, reviewRounds: 2, reviewWaitPendingMs: 60_000, p0: 1, p1: 1 } }),
      task("B", "merge", { metrics: { ...metrics, reviewRounds: 1, p0: 1, p1: 2 } }),
      task("C", "done", { metrics: { ...metrics, reviewRounds: 3, p1: 1 } }),
      task("D", "build", { kind: "ops", metrics: { ...metrics, reviewWaitPendingMs: 180_000 } }),
      task("E", "cancelled"),
    ];
    expect(metricsOf({ tasks }, 1, 4)).toEqual({ present: 4, active: 2, todayDone: 1, reviewRounds: 6, fixed: 4, avgReviewWaitMs: 120_000 });
    expect(metricsOf({ tasks: [task("X", "build")] }, 0, 0).avgReviewWaitMs).toBeNull();
  });
});

describe("大纲筛选", () => {
  const p0Review = { round: 1, verdict: "changes", p0: 1, p1: 0, p2: 0, text: "", ts: 0 };
  const tasks = [task("A", "build"), task("B", "spec", { blockedBy: ["A"] }), task("C", "done"), task("D", "review", { lastReview: p0Review }),
    task("E", "build", { itemId: null }), task("F", "cancelled")];
  test("可执行 = 没挡着的在跑任务；在等 = 被挡着的；已完成含 verified；P0 看累计或最近一轮；全部不含取消的", () => {
    const ids = (f: Parameters<typeof matchFilter>[1]) => tasks.filter((t) => matchFilter(t, f)).map((t) => t.id);
    expect(ids("runnable")).toEqual(["A", "D", "E"]);
    expect(ids("waiting")).toEqual(["B"]);
    expect(ids("done")).toEqual(["C"]);
    expect(ids("p0")).toEqual(["D"]);
    expect(ids("all")).not.toContain("F");
  });
  test("按事项分组，没归事项的放最后，空组不出", () => {
    const g = outlineOf({ tasks, items: [{ id: "I1", title: "事项一", oneLine: "" }, { id: "I2", title: "空的", oneLine: "" }] }, "runnable");
    expect(g.map((x) => [x.id, x.tasks.map((t) => t.id)])).toEqual([["I1", ["A", "D"]], [null, ["E"]]]);
  });
});

describe("手机分组与因果线", () => {
  test("可执行 / 在跑 → 在等 → 今日完成；空的一组不出", () => {
    const tasks = [task("A", "build"), task("B", "spec", { blockedBy: ["A"] }), task("C", "done")];
    expect(mobileSections({ tasks }, ["C"])).toEqual([{ key: "running", ids: ["A"] }, { key: "waiting", ids: ["B"] }, { key: "done", ids: ["C"] }]);
    expect(mobileSections({ tasks: [task("A", "build")] }, []).map((s) => s.key)).toEqual(["running"]);
  });
  test("挡着它的那条：「前置 → 条件」；没写条件只给前置；不挡 = null", () => {
    const deps = [dep("A", "B", { when: "定死 waitForIdle" })];
    expect(blockLine(task("B", "spec", { blockedBy: ["A"] }), deps)).toBe("A → 定死 waitForIdle");
    expect(blockLine(task("C", "spec", { blockedBy: ["A"] }), deps)).toBe("A");
    expect(blockLine(task("D", "build"), deps)).toBeNull();
    expect(causeOf("B", deps)).toEqual({ incoming: deps, outgoing: [] });
  });
  test("边的判定依据：PM 定死的写明推导值；没定死的说按阶段推导", () => {
    expect(edgeBasis(dep("A", "B", { state: "done", derived: "active", effective: "done" }), tr)).toBe("PM 定为「已成立」（推导值「判定中」）");
    expect(edgeBasis(dep("A", "B", { derived: "active", effective: "active" }), tr)).toBe("按前置任务的阶段推导：判定中");
  });
  test("项目概览的阶段计数：审查和返工同一列，只出有数的", () => {
    expect(stageCounts({ tasks: [task("A", "review"), task("B", "fix"), task("C", "build"), task("D", "done")] })).toEqual([{ label: "开发", n: 1 }, { label: "审查 ⇄ 返工", n: 2 }]);
  });
});
