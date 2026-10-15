/**
 * PMEMTUNE1 验收线 4（metrics）：按渠道的覆盖、未覆盖原因分布（只读、只加字段）；带 elapsedMs 的 memory_rank 让 costLatency 有样本。
 * 原有字段含义不变：coverage 照旧只看推出事件。夹具非生产数据。
 */
import { expect, test } from "bun:test";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { channelCoverage, costLatency, coverage, memoryMetrics, type MetricsInput } from "../src/lib/memory-metrics.js";

const P = "demo", H = "a".repeat(40);
let seq = 0;
const ev = (target: string, kind: LedgerEvent["kind"], ts: number, data: Record<string, unknown>): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "scheduler", project: P, target, kind, text: "", data, dedupKey: null });
const stage = (t: string, ts: number, from: string, to: string) => ev(t, "stage", ts, { from, to });
const push = (t: string, ts: number, ids: string[], channel?: string, order = "write") =>
  ev(t, "scheduler", ts, { op: "memory_retrieve", order, specRev: 1, head: H, memoryIds: ids, rankingSeq: 0, ...(channel ? { channel } : {}) });
const attempt = (t: string, ts: number, channel: string, result: string, order = "write") =>
  ev(t, "note", ts, { op: "memory_inject_attempt", taskId: t, orderId: `${t}:${ts}`, channel, order, result, count: result === "injected" ? 1 : 0, elapsedMs: 5 });
const observeSample = (t: string, ts: number) =>
  ev(t, "note", ts, { op: "recovery_observe", mechanism: "memoryLendInjection", actionKey: `lend:${t}`, order: "write", result: "injected", count: 1 });

/**
 * A：本机领单推出（老事件不带 channel）→ local_take 覆盖。B：出借推出 → lend 覆盖。C：直发推出 → direct 覆盖。
 * D：出借尝试 filtered_visibility；E：本机领单 budget_drop；F：直发 error；G：出借 observe 样本；H：什么都没有（没领单）；
 * I：本机 empty。J：只有审查单尝试 / 推出 → 不进写单分母的原因（no_attempt）。
 */
function fixture(): MetricsInput {
  seq = 0;
  const events: LedgerEvent[] = [];
  const card = (t: string, ...xs: ((t: string, ts: number) => LedgerEvent)[]) => {
    events.push(stage(t, 10, "spec", "build"));
    xs.forEach((x, i) => events.push(x(t, 11 + i)));
    events.push(stage(t, 50, "build", "review"));
  };
  card("A", (t, ts) => attempt(t, ts, "local_take", "injected"), (t, ts) => push(t, ts, ["m1"]));
  card("B", (t, ts) => push(t, ts, ["m1"], "lend"), (t, ts) => attempt(t, ts, "lend", "injected"));
  card("C", (t, ts) => push(t, ts, ["m1"], "direct"));
  card("D", (t, ts) => attempt(t, ts, "lend", "filtered_visibility"));
  card("E", (t, ts) => attempt(t, ts, "local_take", "budget_drop"));
  card("F", (t, ts) => attempt(t, ts, "direct", "error"));
  card("G", (t, ts) => observeSample(t, ts));
  card("H");
  card("I", (t, ts) => attempt(t, ts, "local_take", "empty"));
  card("J", (t, ts) => attempt(t, ts, "lend", "injected", "review"), (t, ts) => push(t, ts, ["m1"], "lend", "review"));
  events.push(ev("A", "scheduler", 20, { op: "memory_rank", order: "write", specRev: 1, head: H, items: [], elapsedMs: 12 }));
  return { events, tasks: [], memories: [], since: 0, until: 1000 };
}

test("[验收线 4] 按渠道覆盖：各渠道有尝试的写单数与其中推出的写单数；老推出事件（无 channel）记 local_take", () => {
  const r = channelCoverage(fixture());
  expect(r.orders).toBe(10);
  expect(r.byChannel).toEqual({
    local_take: { orders: 3, covered: 1, rate: 1 / 3 },
    lend: { orders: 3, covered: 1, rate: 1 / 3 },
    direct: { orders: 2, covered: 1, rate: 1 / 2 },
  });
});

test("[验收线 4] 未覆盖原因分布：最后一次尝试的结果；出借 observe 样本 = observe；没有任何尝试 = no_attempt", () => {
  expect(channelCoverage(fixture()).uncovered).toEqual({ empty: 1, budget_drop: 1, filtered_visibility: 1, error: 1, observe: 1, no_attempt: 2 });
});

test("原有字段含义不变：coverage 照旧（3 / 10），costLatency 读 memory_rank.elapsedMs 不再是 0 样本；报告只加字段", () => {
  const input = fixture();
  expect(coverage(input)).toEqual({ orders: 10, covered: 3, rate: 0.3 });
  expect(costLatency(input)).toMatchObject({ retrievalSamples: 1, retrievalP95Ms: 12 });
  const report = memoryMetrics(input);
  expect(report.coverage).toEqual(coverage(input));
  expect(report.channelCoverage).toEqual(channelCoverage(input));
  expect(report.summaryCost).toEqual({ priced: 0, noModelCall: 0, costUnknown: 0, unmarked: 0 });
});

test("lend-observe-missing-attempts: observe distinguishes empty and error from no attempt", () => {
  for (const result of ["empty", "error"] as const) {
    const sample = observeSample("T", 11);
    sample.data.result = result;
    sample.data.count = 0;
    const input = { events: [stage("T", 10, "spec", "build"), sample], tasks: [], memories: [], since: 0, until: 1000 };
    // Sequence defines phase boundaries; keep the stage before the sample.
    input.events[0]!.seq = sample.seq - 1;
    const report = channelCoverage(input);
    expect(report.uncovered[result]).toBe(1);
    expect(report.uncovered.no_attempt).toBe(0);
    expect(report.byChannel.lend).toMatchObject({ orders: 1, covered: 0 });
  }
});
