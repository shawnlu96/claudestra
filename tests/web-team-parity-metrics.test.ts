/**
 * team-parity-A 纯函数一侧（docs/team/team-collab-parity-plan.md §5.0 / §5.1 P1-A）：未知指标按每次总览的 unknownMetrics 给，
 * 不是源级布尔；未知 ≠ 0，团队镜像的 observedAt 不能当完成时刻。React 挂载那一侧在 tests/web-dom-team-parity-calls.test.ts。
 */
import { expect, test } from "bun:test";
import { homeView, type LedgerOverview } from "@/features/collab/collab-model";
import { metricsOf } from "@/features/collab/v4/v4-model";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { SharedLedgerSession, type Transport } from "@/lib/api/shared-ledger";

const NOW = Date.now();
const fx = generateTeamFixture({ now: NOW });

async function teamOv(): Promise<LedgerOverview> {
  const details = new Map(fx.details.map((d) => [d.feature.id, d]));
  const transport: Transport = { list: async () => fx.list, detail: async (id) => details.get(id)!,
    command: async () => { throw new Error("unused"); }, receipt: async (id) => ({ status: "unknown", requestId: id }) };
  const src = sharedCollabSource(new SharedLedgerSession({ center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" }, transport), "team", "label");
  return src.overview(new AbortController().signal);
}

test("复现测试:团队总览带 unknownMetrics 四项，done 卡镜像刚刷新也不算今日完成", async () => {
  const ov = await teamOv();
  const done = ov.tasks.filter((t) => t.stage === "done" || t.stage === "verified");
  expect(done.length).toBeGreaterThan(0);
  expect(done.every((t) => t.updatedAt === NOW)).toBe(true); // updatedAt = observedAt（镜像刷新时刻）
  expect(ov.unknownMetrics).toEqual(["todayDone", "reviewRounds", "fixed", "reviewWait"]);
  const hv = homeView(ov, NOW);
  expect(hv.todayDone).toEqual([]);
  const m = metricsOf(ov, hv.todayDone.length, null);
  expect(m).toEqual({ present: null, active: m.active, todayDone: null, reviewRounds: null, fixed: null, avgReviewWaitMs: null });
  expect(m.active).toBeGreaterThan(0); // 进行中只看阶段，团队数据有
});

test("防回归:本机总览不带 unknownMetrics，数字照旧（缺省 = 全部已知）", () => {
  const done = fx.local.tasks.filter((t) => t.stage === "done" || t.stage === "verified");
  const local: LedgerOverview = { ...fx.local, tasks: fx.local.tasks.map((t) => t.stage === "review" ? { ...t, metrics: { reviewRounds: 2, reviewWaitPendingMs: 60_000 } } : t) };
  expect(local.unknownMetrics).toBeUndefined();
  const hv = homeView(local, NOW);
  expect(hv.todayDone.length).toBe(done.length);
  const m = metricsOf(local, hv.todayDone.length, 4);
  expect(m.present).toBe(4);
  expect(m.todayDone).toBe(done.length);
  expect(m.reviewRounds).toBe(2 * local.tasks.filter((t) => t.stage === "review").length);
  expect(m.fixed).toBe(0);
  expect(m.avgReviewWaitMs).toBe(60_000);
});

test("每项单独未知只置空那一项；本机没人在等审查仍是 null（显示「—」），不是未知", () => {
  const base: LedgerOverview = { ...fx.local, tasks: fx.local.tasks.map((t) => ({ ...t, metrics: { reviewRounds: 1, p0: 1, p1: 0 } })) };
  const known = metricsOf(base, 2, 1);
  expect(known.avgReviewWaitMs).toBeNull();
  expect(known.reviewRounds).toBe(base.tasks.length);
  for (const k of ["todayDone", "reviewRounds", "fixed"] as const) {
    const m = metricsOf({ ...base, unknownMetrics: [k] }, 2, 1);
    expect(m[k]).toBeNull();
    expect({ ...m, [k]: known[k] }).toEqual(known);
  }
  const wait = { ...base, tasks: base.tasks.map((t) => ({ ...t, metrics: { ...t.metrics, reviewWaitPendingMs: 1000 } })) };
  expect(metricsOf(wait, 2, 1).avgReviewWaitMs).toBe(1000);
  expect(metricsOf({ ...wait, unknownMetrics: ["reviewWait"] }, 2, 1).avgReviewWaitMs).toBeNull();
  // 只有 todayDone 未知时，homeView 也不按 updatedAt 列「今日完成」
  expect(homeView({ ...base, unknownMetrics: ["todayDone"] }, NOW).todayDone).toEqual([]);
});
