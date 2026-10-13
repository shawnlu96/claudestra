/**
 * 协作视图 v4 除画布外的纯逻辑（docs/team/collab-view-v4.md）：顶部指标条、大纲筛选、手机分组、任务的因果线、项目概览的阶段计数。
 * 输入是台账总览（和 homeView 的结果）；在干活 / 在等 / 没开工 / 已完成四个词的数一律来自 count-words.ts（看板口径），这里不按阶段另推。
 * 单测 tests/web-collab-v4-model.test.ts。
 */
import type { LedgerDepView, LedgerOverview, LedgerTaskView, Stage, Tr } from "../collab-model";
import { restCount, restSum } from "@/lib/api/ledger-done";
import { doneCount, type CountSnap } from "../count-words";

/** verified 也算完成：「已完成」筛选、大纲绿点、手机分组同一口径 */
const TERMINAL: ReadonlySet<Stage> = new Set(["verified", "done", "cancelled"]);
const PAST_REVIEW: ReadonlySet<Stage> = new Set(["merge", "live", "verified", "done"]);
const open = (t: LedgerTaskView) => !TERMINAL.has(t.stage) && t.kind !== "ops";
const blocked = (t: LedgerTaskView) => (t.blockedBy?.length ?? 0) > 0;

export interface Metrics {
  /** null = 这个源不知道谁在场（团队键对不上本机 registry），不是 0 */
  present: number | null;
  /** null = 这次总览没有完成时刻（unknownMetrics 里有 todayDone） */
  todayDone: number | null;
  reviewRounds: number | null;
  /** 审出来、已经过了审查（合并及以后）的 P0 + P1 */
  fixed: number | null;
  /** 此刻在等审查的任务平均已经等了多久；没有在等的 = null（「—」）；未知看 ov.unknownMetrics 的 reviewWait（「暂无」） */
  avgReviewWaitMs: number | null;
}

/**
 * 计数都把总览窗口外的已完成卡（ov.doneRest）补上：分页只少了列表里的卡，数字不跟着变。
 * ov.unknownMetrics 里的项给 null：缺省字段在本机等于 0，团队数据不能借这个约定把「不知道」算成 0
 */
export function metricsOf(ov: Pick<LedgerOverview, "tasks" | "doneRest" | "unknownMetrics">, todayDone: number, present: number | null): Metrics {
  const unknown = new Set(ov.unknownMetrics ?? []);
  const waits = ov.tasks.map((t) => t.metrics?.reviewWaitPendingMs).filter((ms): ms is number => typeof ms === "number");
  return {
    present,
    todayDone: unknown.has("todayDone") ? null : todayDone,
    reviewRounds: unknown.has("reviewRounds") ? null : ov.tasks.reduce((s, t) => s + (t.metrics?.reviewRounds ?? 0), 0) + restSum(ov, () => true, "reviewRounds"),
    fixed: unknown.has("fixed") ? null : ov.tasks.filter((t) => PAST_REVIEW.has(t.stage)).reduce((s, t) => s + (t.metrics?.p0 ?? 0) + (t.metrics?.p1 ?? 0), 0)
      + restSum(ov, (t) => PAST_REVIEW.has(t.stage), "p0p1"),
    avgReviewWaitMs: !unknown.has("reviewWait") && waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
  };
}

export const FILTERS = ["active", "done", "all", "p0"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_LABEL: Record<Filter, string> = { active: "进行中", done: "已完成", all: "全部", p0: "P0" };
/** 一进来只看进行中（在干活 + 在等）的卡，规格排队和已结案的不挡眼 */
export const DEFAULT_FILTER: Filter = "active";

/**
 * 筛选芯片上的数：进行中 = 看板的在干活 + 在等（count-words.ts，和顶栏同一个数）；已完成同 doneCount；其余 = 总览里的 + 窗口外的。
 * 进行中在计数源没载完时为 null（芯片显示骨架）
 */
export function filterCount(ov: Pick<LedgerOverview, "tasks" | "doneRest">, f: Filter, snap: CountSnap | null): number | null {
  if (f === "active") return snap ? snap.words.working + snap.words.waiting : null;
  if (f === "done") return doneCount(ov);
  return ov.tasks.filter((t) => matchFilter(t, f, null)).length + restCount(ov, (t) => matchFilter(t, f, null));
}

/** active = 进行中的卡号（CountSnap.active）；还没有时进行中一张也不列 */
export function matchFilter(t: LedgerTaskView, f: Filter, active: ReadonlySet<string> | null): boolean {
  if (f === "active") return !!active?.has(t.id);
  if (f === "all") return t.stage !== "cancelled";
  if (f === "done") return t.stage === "done" || t.stage === "verified";
  return (t.metrics?.p0 ?? 0) > 0 || (t.lastReview?.p0 ?? 0) > 0;
}

/** 大纲：事项 → 任务（按筛选），没归事项的放最后一组；空组不出 */
export function outlineOf(ov: Pick<LedgerOverview, "tasks" | "items">, f: Filter, active: ReadonlySet<string> | null = null): { id: string | null; title: string; tasks: LedgerTaskView[] }[] {
  const known = new Set(ov.items.map((i) => i.id));
  const groups = [...ov.items.map((i) => ({ id: i.id as string | null, title: i.title })), { id: null, title: "" }];
  return groups
    .map((g) => ({ ...g, tasks: ov.tasks.filter((t) => matchFilter(t, f, active) && (g.id ? t.itemId === g.id : !t.itemId || !known.has(t.itemId))) }))
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

/** 项目概览「各阶段」：只数在干活 + 在等的卡（count-words.ts countSnap），各列之和 = 在干活 + 在等；没有规格列 */
export const stageCounts = (snap: CountSnap): { label: string; n: number }[] => snap.stages;
