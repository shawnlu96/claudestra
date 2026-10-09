/**
 * 已完成卡分页（bridge i28-V1p：GET /api/v1/ledger/:project/done，src/lib/ledger-read-done.ts）与窗口外计数。
 * 总览只带已完成卡的窗口（最近 30 张，另带至多 30 张历史依赖卡），更早的给游标 doneCursor 和聚合 doneRest；
 * 这里把 doneRest 补进筛选计数 / 指标条 / 画布 ✓ N，并把翻到的页和总览合成一份。web 不 import src：类型按服务端手抄。
 * 老 bridge 不带 doneCursor / doneRest = 总览就是全量，这里一律按 0 / 不翻页处理。单测 tests/web-collab-done.test.ts。
 */
import type { LedgerOverview, LedgerTaskView, Stage } from "@/features/collab/collab-model";
import { api } from "./client";

/** 窗口外按（阶段、kind、挡没挡、有没有 P0）聚的一组；p0p1 = 这组审出来的 P0 + P1 之和 */
export type DoneRestGroup = { stage: Stage; kind: string; blocked: boolean; p0: boolean; n: number; reviewRounds: number; p0p1: number };
/** byItem：事项 id（没归事项为 ""）→ 各阶段张数 */
export type DoneRest = { n: number; groups: DoneRestGroup[]; byItem: Record<string, Partial<Record<Stage, number>>> };
export interface DonePage {
  tasks: LedgerTaskView[];
  nextCursor: string | null;
}
type WithRest = { doneRest?: unknown };

const DONE_PAGE_LIMIT = 50;

export function fetchLedgerDone(project: string, before: string, signal?: AbortSignal, limit = DONE_PAGE_LIMIT): Promise<DonePage> {
  return api<DonePage>(`/ledger/${encodeURIComponent(project)}/done?before=${encodeURIComponent(before)}&limit=${limit}`, { timeoutMs: 10_000, signal });
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 窗口外的分组；缺字段 / 形状不对（老 bridge、坏缓存）= 没有 */
function groupsOf(ov: WithRest): DoneRestGroup[] {
  const rest = ov.doneRest;
  if (!isObj(rest) || !Array.isArray(rest.groups)) return [];
  return rest.groups.filter((g): g is DoneRestGroup => isObj(g) && typeof g.stage === "string" && typeof g.kind === "string");
}

/** 一组窗口外的卡当成一张卡给筛选谓词看：谓词只读 stage / kind / blockedBy / metrics.p0 */
const asTask = (g: DoneRestGroup): LedgerTaskView => ({
  id: "", title: "", kind: g.kind, stage: g.stage, round: 0, updatedAt: 0, blockedBy: g.blocked ? ["?"] : [], metrics: { p0: g.p0 ? 1 : 0 },
});

/** 窗口外满足 pred 的张数（筛选芯片、指标条「在跑」） */
export function restCount(ov: WithRest, pred: (t: LedgerTaskView) => boolean): number {
  return groupsOf(ov).reduce((s, g) => s + (pred(asTask(g)) ? num(g.n) : 0), 0);
}

/** 窗口外满足 pred 的卡的审查轮数 / P0+P1 之和（指标条） */
export function restSum(ov: WithRest, pred: (t: LedgerTaskView) => boolean, key: "reviewRounds" | "p0p1"): number {
  return groupsOf(ov).reduce((s, g) => s + (pred(asTask(g)) ? num(g[key]) : 0), 0);
}

/** 窗口外某个事项（itemIds 里任一；没归事项用 ""）在 stage 的张数：因果画布框角 ✓ N */
export function restInItems(ov: WithRest, itemIds: readonly string[], stage: Stage): number {
  const rest = ov.doneRest;
  if (!isObj(rest) || !isObj(rest.byItem)) return 0;
  const byItem = rest.byItem as Record<string, unknown>;
  return itemIds.reduce((s, id) => s + (isObj(byItem[id]) ? num((byItem[id] as Record<string, unknown>)[stage]) : 0), 0);
}

/** 完成时刻：和服务端同一口径（metrics.endTs，缺省 updatedAt） */
export const doneAt = (t: LedgerTaskView): number => t.metrics?.endTs ?? t.updatedAt;
/** 服务端的次序：完成时刻倒序、同一时刻 id 倒序 */
export const byDone = (a: LedgerTaskView, b: LedgerTaskView): number => doneAt(b) - doneAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** 已翻到的页并上新一页：按 id 去重（后到的是新数据），总览里有的不再列（窗口里那张更新），按服务端次序排 */
export function mergeDone(pages: readonly LedgerTaskView[], page: readonly LedgerTaskView[], ov: Pick<LedgerOverview, "tasks">): LedgerTaskView[] {
  const inOv = new Set(ov.tasks.map((t) => t.id));
  const byId = new Map(pages.map((t) => [t.id, t]));
  for (const t of page) byId.set(t.id, t);
  return [...byId.values()].filter((t) => !inOv.has(t.id)).sort(byDone);
}

/**
 * 总览重拉后窗口往新挪了（新完成了卡）：窗口里原先最旧的几张掉出总览、又在已翻到的页之前，要从新游标起补一段。
 * 补到的这页最旧一张已经不比已翻到的最新一张新（接上了）、或这页是空的 / 没有更早的了，就补齐了。
 */
export function gapClosed(pages: readonly LedgerTaskView[], page: DonePage): boolean {
  const last = page.tasks.at(-1);
  return !last || page.nextCursor === null || pages.length === 0 || byDone(last, pages[0]!) >= 0;
}

/** 一个「已完成」区的翻页状态：页、往更早翻的游标、上次看到的总览游标、在拉的那一单（more = 往下翻，gap = 窗口挪了补一段） */
export interface DoneChain {
  pages: LedgerTaskView[];
  next: string | null;
  anchor: string | null | undefined;
  job: { kind: "more" | "gap"; before: string } | null;
}

export const newChain = (ov: Pick<LedgerOverview, "doneCursor">): DoneChain => ({ pages: [], next: ov.doneCursor ?? null, anchor: ov.doneCursor, job: null });

/** 总览重拉了：回到总览的卡从页里去掉；游标变了且已经翻过页 = 窗口挪了，从新游标补一段；还没翻过就只换起点 */
export function chainOnOverview(c: DoneChain, ov: Pick<LedgerOverview, "tasks" | "doneCursor">): DoneChain {
  const pages = mergeDone(c.pages, [], ov);
  const cursor = ov.doneCursor;
  if (cursor === c.anchor) return { ...c, pages };
  if (pages.length === 0 || !cursor) return { ...c, pages, anchor: cursor, next: c.job ? c.next : cursor ?? null };
  return { ...c, pages, anchor: cursor, job: { kind: "gap", before: cursor } };
}

/** 往下翻一页；在拉 / 没有更早的 = null（不发请求） */
export function chainLoadMore(c: DoneChain): DoneChain | null {
  return c.job || !c.next ? null : { ...c, job: { kind: "more", before: c.next } };
}

/** 一页回来了：并进页；往下翻的更新 next，补段没接上就接着补（job 还在 = 调用方再拉一次） */
export function chainOnPage(c: DoneChain, page: DonePage, ov: Pick<LedgerOverview, "tasks">): DoneChain {
  const job = c.job;
  if (!job) return c;
  const closed = job.kind === "gap" && gapClosed(c.pages, page);
  return {
    ...c,
    pages: mergeDone(c.pages, page.tasks, ov),
    next: job.kind === "more" ? page.nextCursor : c.next,
    job: job.kind === "gap" && !closed && page.nextCursor ? { kind: "gap", before: page.nextCursor } : null,
  };
}
