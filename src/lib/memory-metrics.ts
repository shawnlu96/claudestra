/**
 * 项目记忆的衡量（设计稿 docs/design/project-memory.md §9）：只读台账事件，按周出九个指标。门槛数字由 owner 定，这里一律留空（null）。
 * 三类数据：单子里推了什么（scheduler 事件 op = memory_retrieve 的 memoryIds，排名事件 items[].routes 给路由）、
 * 执行者怎么用（memory 事件 op = refs）、之后同类 P1 还出不出现（review 事件 findings，口径同 memory-auto-pitfalls：countsAsP1 + normalizedFamily）。
 * 只算不读库（输入是事件 / 卡 / 记忆数组），读库与 CLI 在 memory-metrics-cmd.ts。tests/memory-metrics.test.ts 每个指标一组定义测试。
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { MemoryKind } from "./ledger-memory-schema.js";
import { taskMetrics } from "./ledger-metrics.js";
import { autoFiles } from "./memory-auto-common.js";
import { overlaps, type MemoryOrderKind, type MemoryRoute } from "./memory-retrieve.js";
import { countsAsP1, normalizedFamily, type ReviewFinding } from "./scheduler-review.js";

const WEEK_MS = 7 * 86_400_000;
/** §9 同类 P1 复发率的对照窗口：上线前 8 周 */
export const BASELINE_MS = 8 * WEEK_MS;
const ROUTES: MemoryRoute[] = ["graph", "file", "vector"];

/** 指标需要的记忆字段 */
export interface MetricsMemory { id: string; kind: MemoryKind; family: string | null; files: string[]; createdAt: number }

export interface MetricsInput {
  /** 本项目全部事件（listEvents 的 seq 顺序） */
  events: readonly LedgerEvent[];
  tasks: readonly LedgerTask[];
  memories: readonly MetricsMemory[];
  /** 统计窗口 [since, until) */
  since: number;
  until: number;
  /** 记忆注入上线时刻；不给 = 本项目第一条推出事件的时刻（都没有 = 没有对照） */
  launchTs?: number | null;
}

/** 推出的一条：同一张单（卡 + specRev + head + 写 / 审查）同一条记忆只算一次，取第一次推出 */
export interface PushedItem { task: string; order: MemoryOrderKind; head: string | null; id: string; ts: number; seq: number; routes: MemoryRoute[] }
/** 一条算数的 P1（本轮仍挡路、没被降级） */
export interface P1Hit { task: string; seq: number; ts: number; family: string }

export function pushedItems(events: readonly LedgerEvent[]): PushedItem[] {
  const ranks = new Map(events.filter((e) => e.kind === "scheduler" && e.data.op === "memory_rank").map((e) => [e.seq, e]));
  const seen = new Set<string>();
  const out: PushedItem[] = [];
  for (const e of events) {
    if (e.kind !== "scheduler" || e.data.op !== "memory_retrieve" || !Array.isArray(e.data.memoryIds)) continue;
    const order: MemoryOrderKind = e.data.order === "review" ? "review" : "write";
    const head = typeof e.data.head === "string" ? e.data.head : null;
    const rank = typeof e.data.rankingSeq === "number" ? ranks.get(e.data.rankingSeq) : undefined;
    const items = Array.isArray(rank?.data.items) ? rank.data.items as { id?: unknown; routes?: unknown }[] : [];
    for (const id of e.data.memoryIds.filter((x): x is string => typeof x === "string")) {
      const key = JSON.stringify([e.target, e.data.specRev ?? null, head, order, id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const routes = items.find((i) => i?.id === id)?.routes;
      out.push({ task: e.target, order, head, id, ts: e.ts, seq: e.seq,
        routes: Array.isArray(routes) ? ROUTES.filter((r) => routes.includes(r)) : [] });
    }
  }
  return out;
}

export function p1Hits(events: readonly LedgerEvent[]): P1Hit[] {
  const byTask = groupByTarget(events);
  return events.filter((e) => e.kind === "review" && Array.isArray(e.data.findings)).flatMap((e) =>
    (e.data.findings as ReviewFinding[]).filter((f) => !!f && typeof f.family === "string" &&
      countsAsP1(byTask.get(e.target) ?? [], Number(e.data.round), f))
      .map((f) => ({ task: e.target, seq: e.seq, ts: e.ts, family: normalizedFamily(f.family) })).filter((h) => !!h.family));
}

function groupByTarget(events: readonly LedgerEvent[]): Map<string, LedgerEvent[]> {
  const m = new Map<string, LedgerEvent[]>();
  for (const e of events) m.set(e.target, [...(m.get(e.target) ?? []), e]);
  return m;
}

const ratio = (n: number, d: number): number | null => (d ? n / d : null);
const inWindow = (ts: number, since: number, until: number) => ts >= since && ts < until;
const famOf = (m: MetricsMemory | undefined) => (m?.kind === "pitfall" && m.family ? normalizedFamily(m.family) : "");

/** 一个（卡, 坑）对：坑在这张卡的单子上第一次推出的位置 */
interface Pair { task: string; id: string; family: string; seq: number }

function pitfallPairs(pushed: readonly PushedItem[], mems: Map<string, MetricsMemory>): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const p of pushed) {
    const family = famOf(mems.get(p.id));
    const key = `${p.task}\u0000${p.id}`;
    if (family && !pairs.has(key)) pairs.set(key, { task: p.task, id: p.id, family, seq: p.seq });
  }
  return [...pairs.values()];
}

const recurrences = (pair: Pair, hits: readonly P1Hit[]) => hits.filter((h) => h.task === pair.task && h.seq > pair.seq && h.family === pair.family);

export interface RecurrenceRate {
  /** 推过坑 F 的（卡, F）对里，之后审查出现 F 同 family P1 的比例 */
  rate: number | null; pairs: number; recurred: number;
  /** 对照：上线前 8 周里，改到 F 的文件的（卡, F）对出现 F 同 family P1 的比例 */
  baseline: { rate: number | null; pairs: number; recurred: number; since: number; until: number } | null;
}

/** 指标 1：同类 P1 复发率（降） */
export function recurrenceRate(input: MetricsInput, pushed = pushedItems(input.events), hits = p1Hits(input.events)): RecurrenceRate {
  const mems = new Map(input.memories.map((m) => [m.id, m]));
  const pairs = pitfallPairs(pushed.filter((p) => inWindow(p.ts, input.since, input.until)), mems);
  const recurred = pairs.filter((p) => recurrences(p, hits).length > 0).length;
  const launch = input.launchTs ?? (pushed.length ? Math.min(...pushed.map((p) => p.ts)) : null);
  return { rate: ratio(recurred, pairs.length), pairs: pairs.length, recurred, baseline: launch === null ? null : baselineRate(input, hits, launch) };
}

function baselineRate(input: MetricsInput, hits: readonly P1Hit[], launch: number): NonNullable<RecurrenceRate["baseline"]> {
  const since = launch - BASELINE_MS;
  const byTask = groupByTarget(input.events);
  const reviewed = input.tasks.filter((t) => (byTask.get(t.id) ?? []).some((e) => e.kind === "review" && inWindow(e.ts, since, launch)));
  const pits = input.memories.filter((m) => famOf(m) && m.files.length);
  let pairs = 0, recurred = 0;
  for (const t of reviewed) {
    const files = autoFiles(t, byTask.get(t.id) ?? []);
    for (const m of pits.filter((m) => m.files.some((a) => files.some((b) => overlaps(a, b, null))))) {
      pairs++;
      if (hits.some((h) => h.task === t.id && h.family === famOf(m) && inWindow(h.ts, since, launch))) recurred++;
    }
  }
  return { rate: ratio(recurred, pairs), pairs, recurred, since, until: launch };
}

export interface PitfallRecurrence { id: string; family: string; cards: number; recurrences: number }

/** 指标 2：坑复发次数（降）——每个推出过的坑，在推过它的卡上之后又出现同 family P1 的次数；多的排前（「推了也没用」，多半要改写 rule） */
export function pitfallRecurrences(input: MetricsInput, pushed = pushedItems(input.events), hits = p1Hits(input.events)): PitfallRecurrence[] {
  const mems = new Map(input.memories.map((m) => [m.id, m]));
  const rows = new Map<string, PitfallRecurrence>();
  for (const pair of pitfallPairs(pushed.filter((p) => inWindow(p.ts, input.since, input.until)), mems)) {
    const row = rows.get(pair.id) ?? { id: pair.id, family: mems.get(pair.id)!.family!, cards: 0, recurrences: 0 };
    row.cards++;
    row.recurrences += recurrences(pair, hits).length;
    rows.set(pair.id, row);
  }
  return [...rows.values()].sort((a, b) => b.recurrences - a.recurrences || a.id.localeCompare(b.id));
}

/** 交付里对一条推出记忆的标注，已对上它推出的那张写单 */
interface MatchedRef { use: "applied" | "irrelevant" | "wrong"; item: PushedItem }

/**
 * memoryRefs 对推出：同一张卡、同一条记忆、在交付之前推出的写单（交付 head 是执行者的新提交，和派单时的 head 对不上，所以不按 head 配）；
 * 每条推出至多被一次标注认领（取最近一次还没被认领的），没推过的 id 不算（分子不超过分母）。
 */
function matchedRefs(events: readonly LedgerEvent[], pushed = pushedItems(events)): MatchedRef[] {
  const writes = pushed.filter((p) => p.order === "write");
  const claimed = new Set<PushedItem>();
  const out: MatchedRef[] = [];
  for (const e of events) {
    if (e.kind !== "memory" || e.data.op !== "refs" || !Array.isArray(e.data.refs)) continue;
    for (const r of e.data.refs as { id?: unknown; use?: unknown }[]) {
      if (r?.use !== "applied" && r?.use !== "irrelevant" && r?.use !== "wrong") continue;
      const item = writes.filter((p) => p.task === e.target && p.id === r.id && p.seq < e.seq && !claimed.has(p)).at(-1);
      if (!item) continue;
      claimed.add(item);
      out.push({ use: r.use, item });
    }
  }
  return out;
}

export interface UseRates { pushed: number; applied: number; irrelevant: number; wrong: number;
  /** 指标 3 引用率（升）/ 4 无关率（降）/ 5 错误率（降）：分母都是窗口内推出到写单的条数（审查单的坑不经 memoryRefs 标） */
  appliedRate: number | null; irrelevantRate: number | null; wrongRate: number | null }

export function useRates(input: MetricsInput, pushed = pushedItems(input.events)): UseRates {
  const writes = pushed.filter((p) => p.order === "write" && inWindow(p.ts, input.since, input.until));
  const refs = matchedRefs(input.events, pushed).filter((r) => inWindow(r.item.ts, input.since, input.until));
  const n = (u: MatchedRef["use"]) => refs.filter((r) => r.use === u).length;
  const [applied, irrelevant, wrong] = [n("applied"), n("irrelevant"), n("wrong")];
  return { pushed: writes.length, applied, irrelevant, wrong,
    appliedRate: ratio(applied, writes.length), irrelevantRate: ratio(irrelevant, writes.length), wrongRate: ratio(wrong, writes.length) };
}

/**
 * 指标 6 覆盖率（参考）：至少推了 1 条的写单 / 全部写单。一张写单 = 卡进 build / fix 的一次（从 blocked 回来不算新单，同 taskMetrics.reworkCount）；
 * 「推了」= 这段 build / fix 期间有一条写单推出。没有记忆的单子不写注入事件，所以分母只能从阶段事件数。
 */
export function coverage(input: MetricsInput, pushed = pushedItems(input.events)): { orders: number; covered: number; rate: number | null } {
  const writes = pushed.filter((p) => p.order === "write");
  let orders = 0, covered = 0;
  for (const own of groupByTarget(input.events).values()) {
    const stages = own.filter((e) => e.kind === "stage");
    stages.forEach((e, i) => {
      if ((e.data.to !== "build" && e.data.to !== "fix") || e.data.from === "blocked" || !inWindow(e.ts, input.since, input.until)) return;
      const end = stages.slice(i + 1).find((s) => s.data.from !== "blocked" && s.data.to !== "blocked")?.seq ?? Infinity;
      orders++;
      if (writes.some((p) => p.task === e.target && p.seq > e.seq && p.seq < end)) covered++;
    });
  }
  return { orders, covered, rate: ratio(covered, orders) };
}

export interface RoundsDiff { hitCards: number; missCards: number; hitAvg: number | null; missAvg: number | null; diff: number | null }

/** 指标 7 轮数差（参考，观察性、不当因果）：窗口内结束（taskMetrics.endTs）的卡，单子上推过坑的与没推过的平均审查轮数之差（有 − 无） */
export function roundsDiff(input: MetricsInput, pushed = pushedItems(input.events)): RoundsDiff {
  const mems = new Map(input.memories.map((m) => [m.id, m]));
  const hit = new Set(pushed.filter((p) => mems.get(p.id)?.kind === "pitfall").map((p) => p.task));
  const byTask = groupByTarget(input.events);
  const groups: Record<"hit" | "miss", number[]> = { hit: [], miss: [] };
  for (const t of input.tasks) {
    const m = taskMetrics(t, byTask.get(t.id) ?? [], input.until);
    if (m.endTs === null || !inWindow(m.endTs, input.since, input.until)) continue;
    groups[hit.has(t.id) ? "hit" : "miss"].push(m.reviewRounds);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const [hitAvg, missAvg] = [avg(groups.hit), avg(groups.miss)];
  return { hitCards: groups.hit.length, missCards: groups.miss.length, hitAvg, missAvg, diff: hitAvg === null || missAvg === null ? null : hitAvg - missAvg };
}

export interface CostLatency {
  /** 每卡总结模型花费：总结记忆的 memory 事件上 data.costUsd 之和 / 有总结的卡数；一条都没带 = null（还没埋点） */
  summaryUsdPerCard: number | null; summaryCards: number;
  /** 每单检索 p95 毫秒（最近秩）：排名事件 op = memory_rank 上的 data.elapsedMs；一条都没带 = null（还没埋点） */
  retrievalP95Ms: number | null; retrievalSamples: number;
}

/** 指标 8 成本 / 延迟（守上限） */
export function costLatency(input: MetricsInput): CostLatency {
  const ev = input.events.filter((e) => inWindow(e.ts, input.since, input.until));
  const summaries = new Set(input.memories.filter((m) => m.kind === "summary").map((m) => m.id));
  const cost = new Map<string, number>();
  for (const e of ev) {
    if (e.kind === "memory" && summaries.has(e.data.memoryId as string) && typeof e.data.costUsd === "number") cost.set(e.target, (cost.get(e.target) ?? 0) + e.data.costUsd);
  }
  const ms = ev.filter((e) => e.kind === "scheduler" && e.data.op === "memory_rank" && typeof e.data.elapsedMs === "number")
    .map((e) => e.data.elapsedMs as number).sort((a, b) => a - b);
  const total = [...cost.values()].reduce((s, x) => s + x, 0);
  return { summaryUsdPerCard: cost.size ? total / cost.size : null, summaryCards: cost.size,
    retrievalP95Ms: ms.length ? ms[Math.ceil(0.95 * ms.length) - 1]! : null, retrievalSamples: ms.length };
}

/** 指标 9 路由贡献（参考）：被 applied 的推出各来自哪几路（一条多路命中每路各计 1；排名事件缺失的记 unknown） */
export function routeContribution(input: MetricsInput, pushed = pushedItems(input.events)): Record<MemoryRoute | "unknown", number> & { applied: number } {
  const out = { graph: 0, file: 0, vector: 0, unknown: 0, applied: 0 };
  for (const r of matchedRefs(input.events, pushed)) {
    if (r.use !== "applied" || !inWindow(r.item.ts, input.since, input.until)) continue;
    out.applied++;
    if (!r.item.routes.length) out.unknown++;
    for (const route of r.item.routes) out[route]++;
  }
  return out;
}

/** §9 表：方向 + 门槛（owner 定，留空） */
export const METRIC_SPECS = {
  recurrenceRate: { label: "同类 P1 复发率", direction: "降", threshold: null },
  pitfallRecurrences: { label: "坑复发次数", direction: "降", threshold: null },
  appliedRate: { label: "引用率", direction: "升", threshold: null },
  irrelevantRate: { label: "无关率", direction: "降", threshold: null },
  wrongRate: { label: "错误率", direction: "降", threshold: null },
  coverage: { label: "覆盖率", direction: "参考", threshold: null },
  roundsDiff: { label: "轮数差", direction: "参考", threshold: null },
  costLatency: { label: "成本 / 延迟", direction: "守上限", threshold: null },
  routeContribution: { label: "路由贡献", direction: "参考", threshold: null },
} as const satisfies Record<string, { label: string; direction: "升" | "降" | "参考" | "守上限"; threshold: number | null }>;

export interface MemoryMetricsReport {
  since: number; until: number;
  recurrenceRate: RecurrenceRate; pitfallRecurrences: PitfallRecurrence[]; uses: UseRates;
  coverage: ReturnType<typeof coverage>; roundsDiff: RoundsDiff; costLatency: CostLatency; routeContribution: ReturnType<typeof routeContribution>;
  specs: typeof METRIC_SPECS;
}

export function memoryMetrics(input: MetricsInput): MemoryMetricsReport {
  const pushed = pushedItems(input.events), hits = p1Hits(input.events);
  return {
    since: input.since, until: input.until,
    recurrenceRate: recurrenceRate(input, pushed, hits), pitfallRecurrences: pitfallRecurrences(input, pushed, hits),
    uses: useRates(input, pushed), coverage: coverage(input, pushed), roundsDiff: roundsDiff(input, pushed),
    costLatency: costLatency(input), routeContribution: routeContribution(input, pushed), specs: METRIC_SPECS,
  };
}

/** 缺省窗口：截至 now 的最近一周 */
export const lastWeek = (now: number): { since: number; until: number } => ({ since: now - WEEK_MS, until: now });
