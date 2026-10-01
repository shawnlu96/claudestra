/**
 * 总览里每张卡的形状（GET /ledger/:project 的 tasks[]、已完成分页 /done 的 tasks[]）与拼它们要的任务视图。
 * 只读：输入是 ledger-store 读出来的行和事件，不碰连接；ledger-read.ts（总览 / 详情）和 ledger-read-done.ts（已完成窗口 / 分页）共用。
 */
import { blockedBy, type DepView } from "./ledger-deps.js";
import { currentStageMark, stageTimeline, taskMetrics, type TaskMetrics } from "./ledger-metrics.js";
import { isAskEvent, TERMINAL_STAGES, type LedgerEvent, type LedgerItem, type LedgerTask, type Stage } from "./ledger-stages.js";
import type { TaskStep } from "./ledger-steps.js";
import type { StepLineInfo } from "./ledger-step-line.js";

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 总览只要一句原因：首行、按码点截到 120（全文在详情接口里） */
const REVIEW_TEXT_MAX = 120;

/** 最近一轮审查的摘要：首页「返工原因」只要这一条，不必为每条线再拉详情 */
interface ReviewSummary {
  round: number | null;
  verdict: string | null;
  p0: number | null;
  p1: number | null;
  p2: number | null;
  text: string;
  ts: number;
}
export interface TaskView extends LedgerTask {
  lastEvent: LedgerEvent | null;
  /** 进入当前阶段的时刻（时间线最后一段的 from）；没有建任务事件的残缺数据为 null */
  stageSince: number | null;
  /** stageSince 是导入时推断的近似时间：网页不拿它判「卡住」，时长前面标 ≈ */
  stageSinceApprox: boolean;
  lastReview: ReviewSummary | null;
  metrics: TaskMetrics;
  /** 挡着它的前置任务 id（ledger-deps.ts blockedBy）；空 = 依赖上不挡 */
  blockedBy: string[];
  /** 不是终态且依赖上不挡（runnableTasks 的口径） */
  runnable: boolean;
}
/**
 * 总览只带网页协作视图读到的字段（web/features/collab/collab-model.ts 的 LedgerOverview）；全量在 taskDetail。
 * 总览经中继上行、每次事件都整份重拉，体积随已完成卡线性涨：加字段前先看网页真的读不读（tests/ledger-read-compact.test.ts 量体积）。
 */
export type OverviewItem = Pick<LedgerItem, "id" | "title" | "oneLine">;
/** 首页指标条、今日完成、p0 筛选用的几个计数；0 / null 不发（网页按缺省 0 / null 读） */
type MetricsSummary = Partial<Pick<TaskMetrics, "endTs" | "reviewRounds" | "p0" | "p1" | "reviewWaitPendingMs">>;
/** 列表小圆点（collab-step-line-model.ts stepLineView）读的几样；head、结论、核验 / 自报只在详情的步骤线里 */
type DotStep = Pick<TaskStep, "step" | "round" | "executor" | "executorKind" | "state"> & { derived?: true };
type DotLine = Omit<StepLineInfo, "steps"> & { steps: DotStep[] };
type OverviewEvent = Pick<LedgerEvent, "seq" | "ts" | "actor" | "target" | "kind" | "text" | "data">;
export type OverviewTask = Partial<Omit<TaskView, "metrics" | "lastEvent">> & Pick<TaskView, "id" | "title" | "kind" | "stage" | "round" | "updatedAt" | "stageSince" | "blockedBy" | "runnable"> & {
  lastEvent?: OverviewEvent | null;
  metrics: MetricsSummary;
  stepLine?: DotLine;
};
export const compactStage = (stage: Stage) => stage === "verified" || TERMINAL_STAGES.includes(stage);

function metricsSummary(m: TaskMetrics): MetricsSummary {
  const out: MetricsSummary = {};
  if (m.endTs !== null) out.endTs = m.endTs; // 完成时刻：之后补的 note 会改 updatedAt，「今日完成」不能跟着漂
  if (m.reviewWaitPendingMs !== null) out.reviewWaitPendingMs = m.reviewWaitPendingMs;
  for (const k of ["reviewRounds", "p0", "p1"] as const) if (m[k]) out[k] = m[k];
  return out;
}

const dotLine = (l: StepLineInfo): DotLine => ({
  ...l,
  steps: l.steps.map((s) => ({ step: s.step, round: s.round, executor: s.executor, executorKind: s.executorKind, state: s.state, ...(s.derived ? { derived: true as const } : {}) })),
});

/** 网页只读 extra 的目标句与委托对象（collab-model goalOf / delegateOf）；fileGlobs、备注这些留在详情 */
function extraSummary(e: Record<string, unknown>): Record<string, unknown> | undefined {
  const out = Object.fromEntries(["goal", "delegate"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
  return Object.keys(out).length ? out : undefined;
}

/**
 * 最近一条事件：网页拿它判红色（rollback / verify 没过）、写一句原因（首行）；stage 的 to 留给网页没有 stageSince 时的兜底。
 * 正文只留首行、data 只留 to / result；全文在详情的 events 里
 */
function eventSummary(e: LedgerEvent | null): OverviewEvent | null {
  if (!e) return null;
  const data = Object.fromEntries(["to", "result"].filter((k) => e.data[k] !== undefined).map((k) => [k, e.data[k]]));
  return { seq: e.seq, ts: e.ts, actor: e.actor, target: e.target, kind: e.kind, text: clipFirstLine(e.text, Infinity), data };
}

/** 在跑的卡：首页的线、因果画布、详情打开前的头部都从这里算 */
export function liveCard(v: TaskView, line: StepLineInfo): OverviewTask {
  return {
    id: v.id, itemId: v.itemId, title: v.title, kind: v.kind, stage: v.stage, stageBefore: v.stageBefore, round: v.round,
    agent: v.agent, pm: v.pm, pr: v.pr, assignee: v.assignee, assigneeKind: v.assigneeKind, updatedAt: v.updatedAt, extra: extraSummary(v.extra),
    lastEvent: eventSummary(v.lastEvent), stageSince: v.stageSince, stageSinceApprox: v.stageSinceApprox, lastReview: v.lastReview,
    metrics: metricsSummary(v.metrics), blockedBy: v.blockedBy, runnable: v.runnable, stepLine: dotLine(line),
  };
}

/**
 * 已完成的卡：大纲 / 计数 / 成员 / PR 对审查员只要这些，空字段不发。dots 给了（今天完成的，「今天」按网页传来的零点，
 * ledger-read-done.ts dayStartOf）就另带手机「今日完成」卡片要的最近事件（红 / 黄色调）和小圆点。分页接口始终带小圆点。
 */
export function doneCard(v: TaskView, dots: StepLineInfo | null): OverviewTask {
  const card: OverviewTask = {
    id: v.id, title: v.title, kind: v.kind, stage: v.stage, round: v.round, updatedAt: v.updatedAt, stageSince: v.stageSince,
    blockedBy: v.blockedBy, runnable: v.runnable, metrics: metricsSummary(v.metrics),
  };
  for (const k of ["itemId", "agent", "pm", "pr"] as const) if (v[k]) card[k] = v[k];
  if (!dots) return card;
  return { ...card, stageSinceApprox: v.stageSinceApprox, lastEvent: eventSummary(v.lastEvent), stepLine: dotLine(dots) };
}

/** 首个非空行，按码点截到 max（超出补 …）：总览只给一句，全文留给详情接口 */
export function clipFirstLine(text: string, max: number = REVIEW_TEXT_MAX): string {
  const first = [...(text.split("\n").find((l) => l.trim()) ?? "").trim()];
  return first.length > max ? `${first.slice(0, max).join("")}…` : first.join("");
}

function reviewSummary(e: LedgerEvent | undefined): ReviewSummary | null {
  if (!e) return null;
  const d = e.data;
  const text = clipFirstLine(e.text);
  return { round: numOrNull(d.round), verdict: typeof d.verdict === "string" ? d.verdict : null, p0: numOrNull(d.p0), p1: numOrNull(d.p1), p2: numOrNull(d.p2), text, ts: e.ts };
}

export function taskView(task: LedgerTask, own: readonly LedgerEvent[], now: number, deps: readonly DepView[]): TaskView {
  const blockers = blockedBy(task.id, deps).map((d) => d.from);
  return {
    ...task,
    // dep 事件是关系变更不是进展、ask 族有自己的卡片：算进来会把回滚 / 验证失败这类「出问题」信号和最近一条进展盖掉（web collab-model 看 lastEvent）
    lastEvent: own.findLast((e) => !isAskEvent(e) && e.kind !== "dep") ?? null,
    stageSince: stageTimeline(own, now).at(-1)?.from ?? null,
    stageSinceApprox: currentStageMark(own)?.data.approxTime === true,
    lastReview: reviewSummary(own.findLast((e) => e.kind === "review")),
    metrics: taskMetrics(task, own, now),
    blockedBy: blockers,
    runnable: !TERMINAL_STAGES.includes(task.stage) && blockers.length === 0,
  };
}

/** 一个项目的事件按 target 分组（保持 seq 升序）；总览和已完成分页都只查一次整个项目的事件 */
export function eventsByTarget(events: readonly LedgerEvent[], only?: ReadonlySet<string>): Map<string, LedgerEvent[]> {
  const byTarget = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    if (only && !only.has(e.target)) continue;
    const list = byTarget.get(e.target);
    if (list) list.push(e);
    else byTarget.set(e.target, [e]);
  }
  return byTarget;
}
