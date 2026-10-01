/**
 * 总览里的已完成卡窗口 + 更早已完成卡的游标分页（GET /ledger/:project/done）。总览每次台账事件都整份重拉、经中继上行，
 * 已完成卡全带会随天数线性涨；所以总览只带窗口：「今天」完成的 ∪ 最近 DONE_RECENT 张 ∪ 跟没完成的卡有依赖边的，
 * 其余只给聚合计数（DoneRest，体积随事项数、不随卡数）和游标，网页按需往下翻。
 * 「今天」从 dayStart 起：网页传它自己的零点（GET /ledger/:project?dayStart=），手机「今日完成」按同一个零点算，跨时区也不丢小圆点；
 * 不传（老网页）按服务器零点。只有今天完成的带小圆点和最近事件，其余窗口卡是精简形（tests/ledger-read-done.test.ts）。
 * 次序 = 完成时刻（metrics.endTs，缺省 updatedAt）倒序、同一时刻按 id 倒序；游标 = 上一页最后一张的「时刻:id」，翻页只取严格更早的。
 */
import type { Database } from "bun:sqlite";
import { depViews, type DepView } from "./ledger-deps.js";
import { compactStage, doneCard, eventsByTarget, taskView, type OverviewTask, type TaskView } from "./ledger-read-cards.js";
import type { Stage } from "./ledger-stages.js";
import { listDeps, listEvents, listTasks } from "./ledger-store.js";

/** 窗口至少带这么多张（一天都没完成卡时，「已完成」区首屏也不空） */
export const DONE_RECENT = 30;
/** 网页传来的零点只认 now 前后这么远：再远就是钟坏了或乱传，按服务器零点 */
const DAY_START_SLACK_MS = 36 * 3_600_000;
/** 一天内完成太多时的硬上限：总览体积宁可封顶，超出的照样能翻页看到 */
const DONE_WINDOW_CAP = 300;
export const DONE_PAGE_DEFAULT = 50;
export const DONE_PAGE_MAX = 100;

/** 不在窗口里的已完成卡按（阶段、kind、挡没挡、有没有 P0）聚成的一组：网页的筛选计数、指标条、阶段列据此补上窗口外的卡 */
interface DoneRestGroup {
  stage: Stage;
  kind: string;
  blocked: boolean;
  p0: boolean;
  n: number;
  reviewRounds: number;
  /** 这组卡审出来的 P0 + P1 之和（网页「修掉的」只算 verified / done，按 stage 自己挑） */
  p0p1: number;
}
export interface DoneRest {
  n: number;
  groups: DoneRestGroup[];
  /** 事项 id（没归事项为 ""）→ 各阶段张数：因果画布事项框角的 ✓ N */
  byItem: Record<string, Partial<Record<Stage, number>>>;
}
export interface DoneWindow {
  keep: Set<string>;
  /** 窗口里今天完成的：带小圆点 */
  today: Set<string>;
  /** 窗口里按次序最后一张的游标；没有更早的了 = null */
  cursor: string | null;
  rest: DoneRest;
}
export interface DonePage {
  tasks: OverviewTask[];
  nextCursor: string | null;
}
interface Cursor {
  at: number;
  id: string;
}

const doneAt = (v: Pick<TaskView, "metrics" | "updatedAt">): number => v.metrics.endTs ?? v.updatedAt;
const byDone = (a: TaskView, b: TaskView) => doneAt(b) - doneAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const doneCursor = (v: TaskView): string => `${doneAt(v)}:${v.id}`;
const older = (v: TaskView, c: Cursor) => doneAt(v) < c.at || (doneAt(v) === c.at && v.id < c.id);

/** 「时刻:id」；时刻是非负整数毫秒，id 非空。别的写法一律 null（接口回 400） */
export function parseDoneCursor(raw: string): Cursor | null {
  const m = /^(\d{1,16}):(.+)$/s.exec(raw);
  if (!m) return null;
  const at = Number(m[1]);
  return Number.isSafeInteger(at) ? { at, id: m[2]! } : null;
}

function restOf(views: readonly TaskView[]): DoneRest {
  const groups = new Map<string, DoneRestGroup>();
  const byItem: DoneRest["byItem"] = {};
  for (const v of views) {
    const g = { stage: v.stage, kind: v.kind, blocked: v.blockedBy.length > 0, p0: (v.metrics.p0 ?? 0) > 0 };
    const key = `${g.stage}|${g.kind}|${g.blocked}|${g.p0}`;
    const cur = groups.get(key) ?? { ...g, n: 0, reviewRounds: 0, p0p1: 0 };
    cur.n++;
    cur.reviewRounds += v.metrics.reviewRounds ?? 0;
    cur.p0p1 += (v.metrics.p0 ?? 0) + (v.metrics.p1 ?? 0);
    groups.set(key, cur);
    const item = (byItem[v.itemId ?? ""] ??= {});
    item[v.stage] = (item[v.stage] ?? 0) + 1;
  }
  return { n: views.length, groups: [...groups.values()], byItem };
}

/** 「今天」的起点：网页传的零点在 now 前后 DAY_START_SLACK_MS 内就用它，否则（没传、乱传）用服务器零点 */
export function dayStartOf(now: number, fromClient: number | null): number {
  if (fromClient !== null && Number.isFinite(fromClient) && Math.abs(now - fromClient) <= DAY_START_SLACK_MS) return fromClient;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** done = 项目里所有已完成（verified / done / cancelled）卡的视图；deps = 项目的依赖边；dayStart = dayStartOf 的结果 */
export function doneWindow(done: readonly TaskView[], deps: readonly DepView[], dayStart: number): DoneWindow {
  const sorted = [...done].sort(byDone);
  const before = sorted.findIndex((v) => doneAt(v) < dayStart);
  const todayN = before < 0 ? sorted.length : before;
  const k = Math.min(Math.max(DONE_RECENT, todayN), DONE_WINDOW_CAP, sorted.length);
  const keep = new Set(sorted.slice(0, k).map((v) => v.id));
  const today = new Set(sorted.slice(0, Math.min(todayN, k)).map((v) => v.id));
  // 跟没完成的卡有边的已完成卡留着：因果画布、「挡着它的那条线」、详情的进出边两端都要对得上号
  const doneIds = new Set(sorted.map((v) => v.id));
  for (const d of deps) {
    if (doneIds.has(d.from) && !doneIds.has(d.to)) keep.add(d.from);
    if (doneIds.has(d.to) && !doneIds.has(d.from)) keep.add(d.to);
  }
  return { keep, today, cursor: k < sorted.length ? doneCursor(sorted[k - 1]!) : null, rest: restOf(sorted.filter((v) => !keep.has(v.id))) };
}

/** before 之后（更早）的一页；before = null 从最新一张起。窗口里的卡也照样出现，网页按 id 去重 */
function donePageOf(done: readonly TaskView[], before: Cursor | null, limit: number): DonePage {
  const rest = [...done].filter((v) => !before || older(v, before)).sort(byDone);
  const page = rest.slice(0, limit);
  return { tasks: page.map((v) => doneCard(v, null)), nextCursor: rest.length > limit ? doneCursor(page.at(-1)!) : null };
}

/** GET /ledger/:project/done：同一个读事务里取任务、依赖、事件，和总览同一口径算视图 */
export function donePage(db: Database, project: string, before: Cursor | null, limit: number, now: number): DonePage {
  return db.transaction(() => {
    const tasks = listTasks(db, project);
    const deps = depViews(listDeps(db, project), tasks);
    const done = tasks.filter((t) => compactStage(t.stage));
    const byTarget = eventsByTarget(listEvents(db, { project }), new Set(done.map((t) => t.id)));
    return donePageOf(done.map((t) => taskView(t, byTarget.get(t.id) ?? [], now, deps)), before, limit);
  }).deferred();
}
