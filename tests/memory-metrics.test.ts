/** §9 每个指标的定义测试（pmem-M7 验收线 1）：一份夹具逐数算出九个指标；门槛留空。夹具非生产数据。 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import {
  BASELINE_MS, costLatency, coverage, memoryMetrics, METRIC_SPECS, pitfallRecurrences, pushedItems, recurrenceRate, roundsDiff,
  routeContribution, useRates, type MetricsInput, type MetricsMemory,
} from "../src/lib/memory-metrics.js";
import { deliverDedupKey } from "../src/lib/memory-tools-refs.js";

const P = "demo", W0 = 1_000_000_000, WEEK = 7 * 86_400_000, H = "a".repeat(40);
let seq = 0;
const ev = (target: string, kind: LedgerEvent["kind"], ts: number, data: Record<string, unknown>): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "scheduler", project: P, target, kind, text: "", data, dedupKey: null });
const stage = (t: string, ts: number, from: string, to: string) => ev(t, "stage", ts, { from, to });
const p1 = (id: string, family: string) => ({ findingId: id, family, severity: "P1", probe: `${family} 复现`, description: "[验收线 1] 夹具" });
const review = (t: string, ts: number, round: number, findings: unknown[]) =>
  ev(t, "review", ts, { round, p0: 0, p1: findings.length, p2: 0, findings });
const rank = (t: string, ts: number, items: { id: string; routes: string[] }[], extra: Record<string, unknown> = {}) =>
  ev(t, "scheduler", ts, { op: "memory_rank", order: "write", specRev: 1, head: H, items, ...extra });
const inject = (t: string, ts: number, ids: string[], rankingSeq: number, order = "write") =>
  ev(t, "scheduler", ts, { op: "memory_retrieve", order, specRev: 1, head: H, memoryIds: ids, rankingSeq });
const refs = (t: string, ts: number, r: { id: string; use: string }[], orderId = `${t}:write:r1`, head = "b".repeat(40)) =>
  ev(t, "memory", ts, { op: "refs", orderId, head, refs: r });
const deliver = (t: string, ts: number, orderId = `${t}:write:r1`, head = "b".repeat(40)): LedgerEvent =>
  ({ ...ev(t, "deliver", ts, { orderId, head }), dedupKey: deliverDedupKey(orderId, head) });
const task = (id: string, fileGlobs: string[] = []): LedgerTask => ({
  id, project: P, itemId: null, title: id, kind: "code", stage: "build", stageBefore: null, round: 1, agent: null, assigneeKind: null, assignee: null,
  pm: null, branch: null, pr: null, headSHA: H, spec: null, specRev: 1, model: null, rev: 1, extra: { fileGlobs }, createdAt: 0, updatedAt: 0 });

const MEMS: MetricsMemory[] = [
  { id: "ab12-m1", kind: "pitfall", family: "widget-tx", files: ["src/lib/widget-store.ts"], createdAt: 0 },
  { id: "ab12-m2", kind: "pitfall", family: "tx-await", files: ["src/lib/*-import.ts"], createdAt: 0 },
  { id: "ab12-m3", kind: "summary", family: null, files: ["src/lib/widget-read.ts"], createdAt: 0 },
  { id: "ab12-d9", kind: "decision", family: null, files: [], createdAt: 0 },
];

/**
 * 上线前 8 周：Z 改 widget-store.ts 出了 widget-tx P1（对 m1 复发）；Y 改 gadget-import.ts 没出 P1（对 m2 不复发）→ 对照 1/2。
 * 窗口内：A 写单推 m1 / m3 / d9（同一张单再推一次 m1 不重复计），交付标 applied / irrelevant / wrong（另一条没推过的 applied 不算），
 * 之后 widget-tx P1 → (A, m1) 复发；审查单再推 m1，同一（卡, 坑）对不重复。B 写单推 m2，审查出的是 widget-tx（不是 m2 的 family），
 * 返工进 fix 没推（覆盖率分母 +1、分子不变），第二轮无 P1。C 没推任何记忆，一轮过。
 */
function fixture(): MetricsInput {
  seq = 0;
  const L = W0 + 1000;
  const events: LedgerEvent[] = [];
  const add = (e: LedgerEvent) => { events.push(e); return e; };
  add(review("Z", L - WEEK, 1, [p1("z1", "widget-tx")]));
  add(review("Y", L - 2 * WEEK, 1, []));
  add(review("X", L - BASELINE_MS - 1, 1, [p1("x1", "widget-tx")])); // 对照窗口外
  add(stage("A", L - 10, "restate", "build"));
  const ra = add(rank("A", L - 5, [{ id: "ab12-m1", routes: ["graph", "file"] }, { id: "ab12-m3", routes: ["vector"] }, { id: "ab12-d9", routes: ["graph"] }]));
  add(inject("A", L, ["ab12-m1", "ab12-m3", "ab12-d9"], ra.seq));
  add(inject("A", L + 1, ["ab12-m1"], ra.seq));
  add(deliver("A", L + 99));
  add(refs("A", L + 100, [{ id: "ab12-m1", use: "applied" }, { id: "ab12-m3", use: "irrelevant" }, { id: "ab12-d9", use: "wrong" }, { id: "ab12-m2", use: "applied" }]));
  add(stage("A", L + 110, "build", "review"));
  const rr = add(rank("A", L + 120, [{ id: "ab12-m1", routes: ["file"] }]));
  add(inject("A", L + 121, ["ab12-m1"], rr.seq, "review"));
  add(review("A", L + 200, 1, [p1("a1", "widget-tx"), p1("a2", "other-fam")]));
  add(stage("A", L + 300, "review", "verified"));
  add(stage("B", L + 10, "restate", "build"));
  const rb = add(rank("B", L + 11, [{ id: "ab12-m2", routes: ["vector"] }]));
  add(inject("B", L + 12, ["ab12-m2"], rb.seq));
  add(stage("B", L + 20, "build", "review"));
  add(review("B", L + 30, 1, [p1("b1", "widget-tx")]));
  add(stage("B", L + 40, "review", "fix"));
  add(stage("B", L + 50, "fix", "review"));
  add(review("B", L + 60, 2, []));
  add(stage("B", L + 70, "review", "verified"));
  add(stage("C", L + 15, "restate", "build"));
  add(stage("C", L + 25, "build", "review"));
  add(review("C", L + 35, 1, []));
  add(stage("C", L + 45, "review", "verified"));
  const tasks = [task("A"), task("B"), task("C"), task("Z", ["src/lib/widget-store.ts"]), task("Y", ["src/lib/gadget-import.ts"]), task("X", ["src/lib/widget-store.ts"])];
  return { events, tasks, memories: MEMS, since: W0, until: W0 + WEEK };
}

describe("§9 指标定义", () => {
  test("推出：同一张单同一条只算一次；写单与审查单各算各的；路由取排名事件", () => {
    const pushed = pushedItems(fixture().events);
    expect(pushed.map((p) => [p.task, p.order, p.id])).toEqual([
      ["A", "write", "ab12-m1"], ["A", "write", "ab12-m3"], ["A", "write", "ab12-d9"], ["A", "review", "ab12-m1"], ["B", "write", "ab12-m2"]]);
    expect(pushed[0]!.routes).toEqual(["graph", "file"]);
  });

  test("1 同类 P1 复发率 = 推过坑 F 的（卡, F）对里之后出现 F 同 family P1 的比例；对照 = 上线前 8 周同文件卡", () => {
    expect(recurrenceRate(fixture())).toEqual({ rate: 0.5, pairs: 2, recurred: 1,
      baseline: { rate: 0.5, pairs: 2, recurred: 1, since: W0 + 1000 - BASELINE_MS, until: W0 + 1000 } });
    // 推之前出现的 P1 不算复发；显式给上线时刻覆盖「第一次推出」
    const f = fixture();
    expect(recurrenceRate({ ...f, events: f.events.map((e) => e.target === "A" && e.kind === "review" ? { ...e, seq: 0 } : e) })).toMatchObject({ recurred: 0 });
    // 上线提前一周：Z 落在上线后不进对照，窗口前移把 X（widget-tx）收进来
    expect(recurrenceRate({ ...f, launchTs: W0 + 1000 - WEEK }).baseline).toMatchObject({ pairs: 2, recurred: 1, until: W0 + 1000 - WEEK });
  });

  test("2 坑复发次数：按坑列，推过它的卡上之后同 family P1 的次数，多的排前", () => {
    expect(pitfallRecurrences(fixture())).toEqual([
      { id: "ab12-m1", family: "widget-tx", cards: 1, recurrences: 1 }, { id: "ab12-m2", family: "tx-await", cards: 1, recurrences: 0 }]);
  });

  test("3/4/5 引用率 / 无关率 / 错误率：分母 = 推到写单的条数；没推过的 id 不计", () => {
    expect(useRates(fixture())).toEqual({ pushed: 4, applied: 1, irrelevant: 1, wrong: 1, appliedRate: 0.25, irrelevantRate: 0.25, wrongRate: 0.25 });
  });

  test("6 覆盖率：进 build / fix 一次算一张写单，期间有推出就算覆盖", () => {
    expect(coverage(fixture())).toEqual({ orders: 4, covered: 2, rate: 0.5 });
  });

  test("7 轮数差：窗口内结束的卡，推过坑的平均轮数 − 没推过的", () => {
    expect(roundsDiff(fixture())).toEqual({ hitCards: 2, missCards: 1, hitAvg: 1.5, missAvg: 1, diff: 0.5 });
  });

  test("8 成本 / 延迟：每卡总结花费、每单检索 p95；没埋点时为 null", () => {
    expect(costLatency(fixture())).toEqual({ summaryUsdPerCard: null, summaryCards: 0, retrievalP95Ms: null, retrievalSamples: 0 });
    seq = 0;
    const events = [
      ev("A", "memory", W0 + 1, { memoryId: "ab12-m3", kind: "summary", costUsd: 0.003 }),
      ev("B", "memory", W0 + 2, { memoryId: "ab12-m3", kind: "summary", costUsd: 0.001 }),
      ev("B", "memory", W0 + 3, { memoryId: "ab12-m1", kind: "pitfall", costUsd: 9 }),
      ...Array.from({ length: 20 }, (_, i) => rank("A", W0 + 10 + i, [], { elapsedMs: (i + 1) * 10 })),
    ];
    const r = costLatency({ events, tasks: [], memories: MEMS, since: W0, until: W0 + WEEK });
    expect(r).toMatchObject({ summaryCards: 2, retrievalP95Ms: 190, retrievalSamples: 20 });
    expect(r.summaryUsdPerCard).toBeCloseTo(0.002);
  });

  test("9 路由贡献：被 applied 的推出各来自哪几路", () => {
    expect(routeContribution(fixture())).toEqual({ graph: 1, file: 1, vector: 0, unknown: 0, applied: 1 });
  });

  test("窗口外的推出不计；空库各比例为 null", () => {
    const f = fixture();
    const later = { ...f, since: W0 + WEEK, until: W0 + 2 * WEEK };
    expect(useRates(later)).toMatchObject({ pushed: 0, appliedRate: null });
    expect(memoryMetrics({ events: [], tasks: [], memories: [], since: 0, until: 1 })).toMatchObject({
      recurrenceRate: { rate: null, baseline: null }, coverage: { rate: null }, roundsDiff: { diff: null }, pitfallRecurrences: [] });
  });

  test("§9 表九项，门槛全部留空（owner 定）", () => {
    expect(Object.values(METRIC_SPECS).map((s) => s.label)).toEqual(
      ["同类 P1 复发率", "坑复发次数", "引用率", "无关率", "错误率", "覆盖率", "轮数差", "成本 / 延迟", "路由贡献"]);
    expect(Object.values(METRIC_SPECS).every((s) => s.threshold === null)).toBe(true);
    expect(memoryMetrics(fixture()).specs).toBe(METRIC_SPECS);
  });
});

/** pmem-M7 第 1 轮审查：观察截止 until、refs 按 orderId/head 找交付归因 */
describe("§9 指标：截止与归因", () => {
  const mems: MetricsMemory[] = [{ id: "m1", kind: "pitfall", family: "widget-tx", files: [], createdAt: 0 }];

  test("until 之后的 refs / P1 / 返工审查 / 新推出不改变已截止的报表", () => {
    seq = 0;
    const base = [stage("A", 1, "restate", "build"), inject("A", 10, ["m1"], 0), deliver("A", 20)];
    const input = { events: base, tasks: [task("A")], memories: mems, since: 0, until: 100 };
    const before = memoryMetrics(input);
    expect(before.uses).toMatchObject({ pushed: 1, applied: 0, appliedRate: 0 });
    expect(before.recurrenceRate).toMatchObject({ rate: 0, recurred: 0 });
    const later = [...base, refs("A", 150, [{ id: "m1", use: "applied" }]), review("A", 160, 1, [p1("a1", "widget-tx")]),
      stage("A", 170, "review", "fix"), inject("A", 180, ["m1"], 0), stage("A", 190, "fix", "review"), review("A", 195, 2, []), stage("A", 199, "review", "verified")];
    const after = memoryMetrics({ ...input, events: later });
    expect(after).toEqual(before);
    expect(after.pitfallRecurrences).toEqual([{ id: "m1", family: "widget-tx", cards: 1, recurrences: 0 }]);
    expect(after.routeContribution.applied).toBe(0);
    // 截止前就结束的卡：截止后又被打回返工，旧周的轮数不变
    seq = 0;
    const done = [stage("B", 1, "restate", "build"), stage("B", 5, "build", "review"), review("B", 6, 1, []), stage("B", 7, "review", "verified")];
    const r0 = roundsDiff({ events: done, tasks: [task("B")], memories: mems, since: 0, until: 100 });
    const r1 = roundsDiff({ events: [...done, stage("B", 120, "verified", "fix"), review("B", 130, 2, [])], tasks: [task("B")], memories: mems, since: 0, until: 100 });
    expect(r1).toEqual(r0);
    expect(r0.missAvg).toBe(1);
  });

  test("上一单交付后补记的 refs 归给上一单的推出，不认领下一单；下一单自己的 refs 也不反认旧单", () => {
    seq = 0;
    const o1 = "A:write:r1", o2 = "A:fix:r2", h1 = "c".repeat(40), h2 = "d".repeat(40);
    const r1 = rank("A", 9, [{ id: "m1", routes: ["graph"] }]);
    const events = [stage("A", 1, "restate", "build"), r1, inject("A", 10, ["m1"], r1.seq), deliver("A", 20, o1, h1),
      stage("A", 22, "build", "review"), stage("A", 25, "review", "fix")];
    const r2 = rank("A", 29, [{ id: "m1", routes: ["vector"] }]);
    events.push(r2, { ...inject("A", 30, ["m1"], r2.seq), data: { ...inject("A", 30, ["m1"], r2.seq).data, head: h1 } },
      refs("A", 40, [{ id: "m1", use: "applied" }], o1, h1));
    const input = { events, tasks: [task("A")], memories: mems, since: 25, until: 50 };
    expect(useRates(input)).toMatchObject({ pushed: 1, applied: 0, appliedRate: 0 });
    expect(routeContribution(input)).toMatchObject({ vector: 0, applied: 0 });
    // 整段看：单一的 applied 归 graph
    expect(routeContribution({ ...input, since: 0 })).toEqual({ graph: 1, file: 0, vector: 0, unknown: 0, applied: 1 });
    // 单二交付后它自己的 refs 只认单二的推出（vector）
    const both = [...events, deliver("A", 60, o2, h2), refs("A", 61, [{ id: "m1", use: "irrelevant" }], o2, h2)];
    expect(useRates({ ...input, events: both, since: 0, until: 100 })).toMatchObject({ pushed: 2, applied: 1, irrelevant: 1 });
    expect(routeContribution({ ...input, events: both, since: 0, until: 100 })).toMatchObject({ graph: 1, vector: 0, applied: 1 });
    // 找不到对应交付的 refs 不算
    expect(useRates({ ...input, events: [...events.slice(0, 3), refs("A", 15, [{ id: "m1", use: "applied" }], "A:write:rX", h1)], since: 0 }))
      .toMatchObject({ pushed: 1, applied: 0 });
  });
  test("同 head 连续返工：每张写单的推出各算各的，同一单内重领仍去重（push-order-dedup）", () => {
    seq = 0;
    const o1 = "A:fix:r1", o2 = "A:fix:r2";
    const r = rank("A", 9, [{ id: "m1", routes: ["graph"] }]);
    const events = [stage("A", 5, "review", "fix"), r, inject("A", 10, ["m1"], r.seq), inject("A", 11, ["m1"], r.seq), deliver("A", 20, o1, H),
      refs("A", 21, [{ id: "m1", use: "applied" }], o1, H), stage("A", 22, "fix", "review"), stage("A", 25, "review", "fix"),
      inject("A", 30, ["m1"], r.seq), deliver("A", 40, o2, H), refs("A", 41, [{ id: "m1", use: "applied" }], o2, H), stage("A", 42, "fix", "review")];
    const all = memoryMetrics({ events, tasks: [task("A")], memories: mems, since: 0, until: 100 });
    expect(all.uses).toMatchObject({ pushed: 2, applied: 2 });
    expect(all.coverage).toEqual({ orders: 2, covered: 2, rate: 1 });
    // 只看第二单所在的窗口
    const second = memoryMetrics({ events, tasks: [task("A")], memories: mems, since: 25, until: 50 });
    expect(second.uses).toMatchObject({ pushed: 1, applied: 1 });
    expect(second.coverage).toEqual({ orders: 1, covered: 1, rate: 1 });
    // 从 blocked 回来不算新单：重领仍去重
    const blocked = [stage("B", 1, "restate", "build"), inject("B", 2, ["m1"], 0), stage("B", 3, "build", "blocked"), stage("B", 4, "blocked", "build"), inject("B", 5, ["m1"], 0)];
    expect(pushedItems(blocked)).toHaveLength(1);
  });
});
