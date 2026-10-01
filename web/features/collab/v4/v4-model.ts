/**
 * 协作视图 v4 除画布外的纯逻辑（docs/team/collab-view-v4.md）：顶部指标条、大纲筛选、手机分组、任务的因果线、项目概览的阶段计数。
 * 输入只有台账总览（和 homeView 的结果）；数据没有的指标（周额度、协作消息数）不在这里造，界面标「暂无」。
 * 单测 tests/web-collab-v4-model.test.ts。
 */
import { COLUMNS, columnOf, type LedgerDepView, type LedgerOverview, type LedgerTaskView, type Stage, type Tr } from "../collab-model";

const TERMINAL: ReadonlySet<Stage> = new Set(["done", "cancelled"]);
const PAST_REVIEW: ReadonlySet<Stage> = new Set(["merge", "live", "verified", "done"]);
const open = (t: LedgerTaskView) => !TERMINAL.has(t.stage) && t.kind !== "ops";
const blocked = (t: LedgerTaskView) => (t.blockedBy?.length ?? 0) > 0;

export interface Metrics {
  present: number;
  active: number;
  todayDone: number;
  reviewRounds: number;
  /** 审出来、已经过了审查（合并及以后）的 P0 + P1 */
  fixed: number;
  /** 此刻在等审查的任务平均已经等了多久；没有在等的 = null */
  avgReviewWaitMs: number | null;
}

export function metricsOf(ov: Pick<LedgerOverview, "tasks">, todayDone: number, present: number): Metrics {
  const waits = ov.tasks.map((t) => t.metrics?.reviewWaitPendingMs).filter((ms): ms is number => typeof ms === "number");
  return {
    present,
    active: ov.tasks.filter(open).length,
    todayDone,
    reviewRounds: ov.tasks.reduce((s, t) => s + (t.metrics?.reviewRounds ?? 0), 0),
    fixed: ov.tasks.filter((t) => PAST_REVIEW.has(t.stage)).reduce((s, t) => s + (t.metrics?.p0 ?? 0) + (t.metrics?.p1 ?? 0), 0),
    avgReviewWaitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
  };
}

export const FILTERS = ["all", "runnable", "waiting", "done", "p0"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_LABEL: Record<Filter, string> = { all: "全部", runnable: "可执行", waiting: "在等", done: "已完成", p0: "P0" };

export function matchFilter(t: LedgerTaskView, f: Filter): boolean {
  if (f === "all") return t.stage !== "cancelled";
  if (f === "runnable") return open(t) && !blocked(t);
  if (f === "waiting") return open(t) && blocked(t);
  if (f === "done") return t.stage === "done" || t.stage === "verified";
  return (t.metrics?.p0 ?? 0) > 0 || (t.lastReview?.p0 ?? 0) > 0;
}

/** 大纲：事项 → 任务（按筛选），没归事项的放最后一组；空组不出 */
export function outlineOf(ov: Pick<LedgerOverview, "tasks" | "items">, f: Filter): { id: string | null; title: string; tasks: LedgerTaskView[] }[] {
  const known = new Set(ov.items.map((i) => i.id));
  const groups = [...ov.items.map((i) => ({ id: i.id as string | null, title: i.title })), { id: null, title: "" }];
  return groups
    .map((g) => ({ ...g, tasks: ov.tasks.filter((t) => matchFilter(t, f) && (g.id ? t.itemId === g.id : !t.itemId || !known.has(t.itemId))) }))
    .filter((g) => g.tasks.length > 0);
}

/** 手机：可执行 / 在跑 → 在等 → 今日完成 */
export function mobileSections(ov: Pick<LedgerOverview, "tasks">, todayDone: readonly string[]): { key: "running" | "waiting" | "done"; ids: string[] }[] {
  const live = ov.tasks.filter(open);
  return [
    { key: "running" as const, ids: live.filter((t) => !blocked(t)).map((t) => t.id) },
    { key: "waiting" as const, ids: live.filter(blocked).map((t) => t.id) },
    { key: "done" as const, ids: [...todayDone] },
  ].filter((s) => s.ids.length > 0);
}

/** 挡着它的那条因果线：「T13a → 定死 waitForIdle」；不挡 = null */
export function blockLine(t: LedgerTaskView, deps: readonly LedgerDepView[]): string | null {
  const from = t.blockedBy?.[0];
  if (!from) return null;
  const d = deps.find((x) => x.from === from && x.to === t.id);
  return d?.when ? `${from} → ${d.when}` : from;
}

/** 任务的因果线：进来的（它在等什么）和出去的（谁在等它） */
export function causeOf(id: string, deps: readonly LedgerDepView[]): { incoming: LedgerDepView[]; outgoing: LedgerDepView[] } {
  return { incoming: deps.filter((d) => d.to === id), outgoing: deps.filter((d) => d.from === id) };
}

/** 边的判定依据：PM 定死的还是按前置阶段推导的 */
export function edgeBasis(d: LedgerDepView, tr: Tr): string {
  return d.state ? tr("PM 定为「{s}」（推导值「{d}」）", { s: tr(STATE_WORD[d.state]), d: tr(STATE_WORD[d.derived]) }) : tr("按前置任务的阶段推导：{d}", { d: tr(STATE_WORD[d.derived]) });
}
export const STATE_WORD: Record<LedgerDepView["effective"], string> = { done: "已成立", active: "判定中", waiting: "还没到" };

/** 项目概览：各阶段列（与 v3 同一套列）的任务数 */
export function stageCounts(ov: Pick<LedgerOverview, "tasks">): { label: string; n: number }[] {
  const n = COLUMNS.map(() => 0);
  for (const t of ov.tasks.filter(open)) n[columnOf(t.stage, t.stageBefore)]!++;
  return COLUMNS.map((label, i) => ({ label, n: n[i]! })).filter((c) => c.n > 0);
}
