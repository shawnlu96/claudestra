/**
 * 协作视图首页的纯逻辑：台账总览（GET /api/v1/ledger/:project）→ 按关注度排好的任务线、一句话状态、今日完成、PM 调度条。
 * 分档与文案的取舍见台账 mockups/T12/ux.md；单测 tests/web-collab-model.test.ts。
 * web 不 import src：类型按 src/lib/ledger-read.ts 的 ProjectView 手抄，字段一律按可缺处理（老 bridge 没有 stageSince / lastReview）。
 * 文案函数收一个 tr（组件传 useT() 的 t，测试用默认的 fillParams = 中文原文），中文原文即字典 key。
 */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";

export type Tr = (s: string, p?: I18nParams) => string;
const zh: Tr = fillParams;

export type Stage = "spec" | "restate" | "build" | "review" | "fix" | "merge" | "live" | "verified" | "done" | "blocked" | "cancelled";

export interface LedgerEventView {
  seq: number;
  ts: number;
  actor: string;
  target: string;
  kind: string;
  text: string;
  data: Record<string, unknown>;
}

export interface ReviewSummaryView {
  round: number | null;
  verdict: string | null;
  p0: number | null;
  p1: number | null;
  p2: number | null;
  text: string;
  ts: number;
}

export interface TaskMetricsView {
  startTs: number | null;
  endTs: number | null;
  stageMs: Partial<Record<Stage, number>>;
  reviewRounds: number;
  reviewWaitPendingMs: number | null;
  p0: number;
  p1: number;
  p2: number;
}

export interface LedgerTaskView {
  id: string;
  itemId: string | null;
  title: string;
  kind: string;
  stage: Stage;
  stageBefore: Stage | null;
  round: number;
  agent: string | null;
  pm: string | null;
  pr: string | null;
  spec: string | null;
  model: string | null;
  extra: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastEvent: LedgerEventView | null;
  stageSince?: number | null;
  lastReview?: ReviewSummaryView | null;
  metrics: TaskMetricsView;
}

export interface LedgerOverview {
  exists: boolean;
  now: number;
  meta: { pms: string[]; docsDir: string | null; queueFrozen: { frozen: boolean; reason: string; since: number | null } };
  items: { id: string; title: string; oneLine: string }[];
  tasks: LedgerTaskView[];
}

/** 首页 7 列；审查与返工同一列（⇄） */
export const COLUMNS = ["规格", "复述", "开发", "审查 ⇄ 返工", "合并", "上线", "验证"] as const;
const COLUMN_OF: Record<Stage, number> = { spec: 0, restate: 1, build: 2, review: 3, fix: 3, merge: 4, live: 5, verified: 6, done: 6, blocked: 2, cancelled: 0 };

/** 在等别人的阶段：停太久就是卡住。build / fix 是在干活，时间长不算卡住（PM 09-28 定） */
const WAIT_STAGES: ReadonlySet<Stage> = new Set(["spec", "restate", "review", "merge", "live", "blocked"]);
export const STUCK_MS = 30 * 60_000;

/** 关注度：数字小的排前面。owner（等你）要 T11 的数据，第一版恒不出现，槽位保留 */
export type Attention = "problem" | "owner" | "stuck" | "waiting" | "progress";
const RANK: Record<Attention, number> = { problem: 0, owner: 1, stuck: 2, waiting: 3, progress: 4 };

/** 语义色：出问题红、等人琥珀、进行中中性、完成绿 */
export type Tone = "red" | "amber" | "neutral" | "green";

export interface LineView {
  id: string;
  title: string;
  goal: string;
  stage: Stage;
  column: number;
  attention: Attention;
  tone: Tone;
  /** 阶段短语：「返工中 · 第 1 轮意见」「等合并 · 队列第 2 位」「开发中」 */
  stageLabel: string;
  dwellMs: number | null;
  stuck: boolean;
  /** 出问题 / 卡住时的一句原因 */
  reason: string;
  /** 前端会话名（去掉 agent- 前缀）；没派人为 null */
  agent: string | null;
  pm: string | null;
  round: number;
  pr: string | null;
}

export interface Headline {
  advancing: number;
  problem: number;
  stuck: number;
  owner: number;
}

export interface PmStrip {
  pm: string | null;
  managing: number;
  reviewing: number;
  queued: string[];
  frozen: string | null;
}

export interface HomeView {
  lines: LineView[];
  headline: Headline;
  todayDone: string[];
  pm: PmStrip;
}

export const bareAgent = (name: string | null | undefined): string | null => (name ? name.replace(/^agent-/, "") : null);

const isClosed = (s: Stage) => s === "done" || s === "cancelled" || s === "verified";

/** 进入当前阶段的时刻：优先 bridge 下发的 stageSince，老 bridge 退到最后一条 stage 事件（没有就不显示时长） */
export function stageSince(t: LedgerTaskView): number | null {
  if (typeof t.stageSince === "number") return t.stageSince;
  const e = t.lastEvent;
  return e && e.kind === "stage" && e.data.to === t.stage ? e.ts : null;
}

export function dwellMs(t: LedgerTaskView, now: number): number | null {
  const since = stageSince(t);
  return since === null ? null : Math.max(0, now - since);
}

export function isStuck(t: LedgerTaskView, now: number): boolean {
  const d = dwellMs(t, now);
  return WAIT_STAGES.has(t.stage) && d !== null && d > STUCK_MS;
}

function isProblem(t: LedgerTaskView): boolean {
  if (t.stage === "fix" || t.stage === "blocked") return true;
  const e = t.lastEvent;
  return !!e && (e.kind === "rollback" || (e.kind === "verify" && e.data.result === "fail"));
}

export function attentionOf(t: LedgerTaskView, now: number): Attention {
  if (isProblem(t)) return "problem";
  if (isStuck(t, now)) return "stuck";
  return t.stage === "build" ? "progress" : "waiting";
}

/** 同处 merge 的任务按进入合并的先后排队：第几位 */
export function mergeQueuePos(t: LedgerTaskView, all: readonly LedgerTaskView[]): number {
  const mine = stageSince(t) ?? Infinity;
  return all.filter((o) => o.stage === "merge" && o.id !== t.id && (stageSince(o) ?? Infinity) < mine).length + 1;
}

export function fmtDuration(ms: number, tr: Tr = zh): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return tr("不到 1分");
  if (m < 60) return tr("{m}分", { m });
  const h = Math.floor(m / 60);
  return m % 60 ? tr("{h}小时{m}分", { h, m: m % 60 }) : tr("{h}小时", { h });
}

function reviewRound(t: LedgerTaskView): number {
  return t.lastReview?.round ?? Math.max(1, t.round);
}

/** 阶段短语：写的是「现在卡在哪 / 在等谁」，不是阶段名本身 */
export function stageLabel(t: LedgerTaskView, all: readonly LedgerTaskView[], frozen: string | null, tr: Tr = zh): string {
  switch (t.stage) {
    case "spec":
      return tr(t.agent ? "等开工" : "排队 · 等派发");
    case "restate":
      return tr("等 PM 放行");
    case "build":
      return tr("开发中");
    case "review":
      return tr("等审查 · 第 {n} 轮", { n: Math.max(1, t.round) });
    case "fix":
      return tr("返工中 · 第 {n} 轮意见", { n: reviewRound(t) });
    case "merge":
      return frozen ? tr("合并队列冻结") : tr("等合并 · 队列第 {n} 位", { n: mergeQueuePos(t, all) });
    case "live":
      return t.lastEvent?.kind === "verify" && t.lastEvent.data.result === "fail" ? tr("线上验证失败") : tr("已上线 · 等验证");
    case "blocked":
      return tr("受阻");
    case "verified":
    case "done":
      return tr("已完成");
    case "cancelled":
      return tr("已取消");
  }
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim())?.trim() ?? "";
}

function reasonOf(t: LedgerTaskView, att: Attention, dwell: number | null, frozen: string | null, tr: Tr): string {
  if (att === "problem") {
    if (t.stage === "fix") return firstLine(t.lastReview?.text ?? "");
    if (t.stage === "blocked") return t.lastEvent?.kind === "stage" ? firstLine(t.lastEvent.text) : "";
    return firstLine(t.lastEvent?.text ?? "");
  }
  if (att === "stuck" && dwell !== null) return tr("已经等了 {d}，超过 30 分钟", { d: fmtDuration(dwell, tr) }) + (frozen ? tr("（冻结：{r}）", { r: frozen }) : "");
  return "";
}

function toneOf(att: Attention): Tone {
  if (att === "problem") return "red";
  if (att === "stuck" || att === "owner" || att === "waiting") return "amber";
  return "neutral";
}

function frozenReason(meta: LedgerOverview["meta"], tr: Tr): string | null {
  return meta.queueFrozen?.frozen ? meta.queueFrozen.reason || tr("已冻结") : null;
}

/** 一句目标：规格卡目标句（extra.goal）→ 所属事项的一句话 → 空 */
export function goalOf(t: LedgerTaskView, items: ReadonlyMap<string, { oneLine: string }>): string {
  const g = t.extra?.goal;
  if (typeof g === "string" && g.trim()) return g.trim();
  return (t.itemId && items.get(t.itemId)?.oneLine) || "";
}

export function lineOf(t: LedgerTaskView, ov: Pick<LedgerOverview, "tasks" | "meta">, items: ReadonlyMap<string, { oneLine: string }>, now: number, tr: Tr = zh): LineView {
  const frozen = frozenReason(ov.meta, tr);
  const att = attentionOf(t, now);
  const dwell = dwellMs(t, now);
  return {
    id: t.id,
    title: t.title,
    goal: goalOf(t, items),
    stage: t.stage,
    column: COLUMN_OF[t.stage === "blocked" ? t.stageBefore ?? "build" : t.stage],
    attention: att,
    tone: toneOf(att),
    stageLabel: stageLabel(t, ov.tasks, frozen, tr),
    dwellMs: dwell,
    stuck: att === "stuck",
    reason: reasonOf(t, att, dwell, frozen, tr),
    agent: bareAgent(t.agent),
    pm: bareAgent(t.pm),
    round: t.round,
    pr: t.pr,
  };
}

/** 排序：关注度 → 同档内停得久的在前 → id 稳定兜底 */
export function sortLines(lines: LineView[]): LineView[] {
  return [...lines].sort((a, b) => RANK[a.attention] - RANK[b.attention] || (b.dwellMs ?? -1) - (a.dwellMs ?? -1) || a.id.localeCompare(b.id));
}

function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function homeView(ov: LedgerOverview, now: number, tr: Tr = zh): HomeView {
  const items = new Map(ov.items.map((i) => [i.id, i]));
  // 没派人的 spec 是 PM 手里的排队，不画成线（PM 调度条里计数）
  const open = ov.tasks.filter((t) => !isClosed(t.stage) && !(t.stage === "spec" && !t.agent));
  const lines = sortLines(open.map((t) => lineOf(t, ov, items, now, tr)));
  const midnight = localMidnight(now);
  const pm = ov.meta.pms[0] ?? open.find((t) => t.pm)?.pm ?? null;
  return {
    lines,
    headline: {
      advancing: lines.length,
      problem: lines.filter((l) => l.attention === "problem").length,
      stuck: lines.filter((l) => l.attention === "stuck").length,
      owner: 0,
    },
    todayDone: ov.tasks
      .filter((t) => (t.stage === "done" || t.stage === "verified") && (t.metrics.endTs ?? t.updatedAt) >= midnight)
      .sort((a, b) => (a.metrics.endTs ?? a.updatedAt) - (b.metrics.endTs ?? b.updatedAt))
      .map((t) => t.id),
    pm: {
      pm: bareAgent(pm),
      managing: open.filter((t) => !pm || t.pm === pm).length,
      reviewing: open.filter((t) => t.stage === "review").length,
      queued: ov.tasks.filter((t) => t.stage === "spec" && !t.agent).map((t) => t.id),
      frozen: frozenReason(ov.meta, tr),
    },
  };
}
