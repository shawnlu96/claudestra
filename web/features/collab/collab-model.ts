/**
 * 协作视图首页的纯逻辑：台账总览（GET /api/v1/ledger/:project）→ 按关注度排好的任务线、一句话状态、今日完成、PM 调度条。
 * 分档与文案的取舍见台账 mockups/T12/ux.md；单测 tests/web-collab-model.test.ts。
 * web 不 import src：类型按 src/lib/ledger-read.ts 的 ProjectView 手抄，字段一律按可缺处理（老 bridge 没有 stageSince / lastReview）。
 * 文案函数收一个 tr（组件传 useT() 的 t，测试用默认的 fillParams = 中文原文），中文原文即字典 key。
 */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";
import { metaOf } from "@/lib/ledger-meta-guard";
import type { DoneRest } from "@/lib/api/ledger-done";

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

/** 总览下发的最近一轮审查（src/lib/ledger-read.ts 的 ReviewSummary） */
export interface ReviewSummaryView { round: number | null; verdict: string | null; p0: number | null; p1: number | null; p2: number | null; text: string; ts: number }

export interface TaskMetricsView {
  startTs: number | null;
  endTs: number | null;
  totalMs?: number;
  stageMs: Partial<Record<Stage, number>>;
  reviewRounds: number;
  reviewWaitPendingMs: number | null;
  p0: number;
  p1: number;
  p2: number;
}

/**
 * 一张卡。总览只带协作视图读的字段（src/lib/ledger-read.ts liveCard / doneCard）：已完成的卡没有空字段、extra、最近事件、
 * 步骤线（今天完成的除外），在跑的卡没有 spec / model / createdAt，extra 只有 goal / delegate；详情接口给全量。
 */
export interface LedgerTaskView {
  id: string;
  itemId?: string | null;
  title: string;
  kind: string;
  stage: Stage;
  stageBefore?: Stage | null;
  round: number;
  agent?: string | null;
  pm?: string | null;
  pr?: string | null;
  spec?: string | null;
  model?: string | null;
  extra?: Record<string, unknown>;
  createdAt?: number;
  updatedAt: number;
  lastEvent?: LedgerEventView | null;
  stageSince?: number | null;
  /** stageSince 是导入推断的近似时间（老 bridge 没有这个字段 = false） */
  stageSinceApprox?: boolean;
  lastReview?: ReviewSummaryView | null;
  metrics: Partial<TaskMetricsView>;
  /** 步骤线（T51，collab-step-line-model.ts 解析）；老 bridge 没有 */
  stepLine?: unknown;
  /** 挡着它的前置任务（src/lib/ledger-deps.ts blockedBy）；老 bridge 没有 = 不挡 */
  blockedBy?: string[];
}

/** 依赖边（src/lib/ledger-deps.ts DepView）：effective = PM 定死的 state，没定就按前置阶段推导的 derived */
export interface LedgerDepView {
  from: string;
  to: string;
  kind: "blocks" | "branch";
  when: string;
  state: "waiting" | "active" | "done" | null;
  derived: "waiting" | "active" | "done";
  effective: "waiting" | "active" | "done";
  fromCancelled?: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerOverview {
  exists: boolean;
  now: number;
  meta: { pms: string[]; docsDir: string | null; queueFrozen: { frozen: boolean; reason: string; since: number | null } };
  items: { id: string; title: string; oneLine: string }[];
  tasks: LedgerTaskView[];
  /** 老 bridge 没有 = 没有依赖边（因果线画布只画分组框） */
  deps?: LedgerDepView[];
  /** 已完成卡只带窗口时（i28-V1p）更早的从这里翻，null = 没有更早的；窗口外的计数在 doneRest。老 bridge 没有 = tasks 是全量 */
  doneCursor?: string | null;
  doneRest?: DoneRest;
}

/** 首页 7 列；审查与返工同一列（⇄） */
export const COLUMNS = ["规格", "复述", "开发", "审查 ⇄ 返工", "合并", "上线", "验证"] as const;
const COLUMN_OF: Record<Stage, number> = { spec: 0, restate: 1, build: 2, review: 3, fix: 3, merge: 4, live: 5, verified: 6, done: 6, blocked: 2, cancelled: 0 };
export const columnOf = (stage: Stage, before: Stage | null = null): number => COLUMN_OF[stage === "blocked" ? before ?? "build" : stage];

/** 这类任务不走的列：调查没有合并 / 上线 / 验证，运维不复述 */
export function skippedColumns(kind: string): number[] {
  return kind === "investigate" ? [4, 5, 6] : kind === "ops" ? [1] : [];
}

/** 在等别人的阶段：停太久就是卡住。build / fix 是在干活，spec 还没开工，时间长都不算卡住（PM 09-28 开工确认 c 条） */
const WAIT_STAGES: ReadonlySet<Stage> = new Set(["restate", "review", "merge", "live", "blocked"]);
export const STUCK_MS = 30 * 60_000;

/** 关注度：数字小的排前面。owner（等你）= 这条线上有开着的「待你处理」（features/asks，homeView 的 waits） */
export type Attention = "problem" | "owner" | "stuck" | "waiting" | "progress";
const RANK: Record<Attention, number> = { problem: 0, owner: 1, stuck: 2, waiting: 3, progress: 4 };

/** 语义色：出问题红、等人琥珀、进行中中性、完成绿 */
export type Tone = "red" | "amber" | "neutral" | "green";

export interface LineView {
  id: string;
  title: string;
  goal: string;
  kind: string;
  stage: Stage;
  column: number;
  attention: Attention;
  tone: Tone;
  /** 阶段短语：「返工中 · 第 1 轮意见」「等合并 · 队列第 2 位」「开发中」 */
  stageLabel: string;
  dwellMs: number | null;
  /** 停留时长是从导入推断的时间算的：显示时前面加 ≈，也不拿它判卡住 */
  dwellApprox: boolean;
  stuck: boolean;
  /** 出问题 / 卡住时的一句原因 */
  reason: string;
  /** 前端会话名（去掉 agent- 前缀）；没派人为 null */
  agent: string | null;
  /** 交给别的实例的 agent 在做（extra.delegate，"<agent>@<peer>"）；本机有执行者时为 null */
  delegate: string | null;
  pm: string | null;
  round: number;
  pr: string | null;
  /** 步骤线的原始数据（T51），列表那一行的小圆点从这里画 */
  stepLine?: unknown;
}

export interface Headline {
  advancing: number;
  problem: number;
  stuck: number;
  /** 归到「等你」的线数（和各条线上的「等你」对得上；没挂到任何线上的 ask 只在侧栏「待你处理」里） */
  owner: number;
}

/** 一条开着的「待你处理」（features/asks 的 WebAsk 里协作视图用到的几个字段） */
export interface OwnerWait {
  id: string;
  taskId: string | null;
  /** bridge 名（agent-xxx / master）；人 / 系统发起的为 null（只按任务号挂线） */
  fromAgent: string | null;
  title: string;
}

/** 这条线在等 owner 的哪件事：挂在这个任务上的优先，其次是这条线的执行者发的、没挂任务的 */
export function waitFor(t: Pick<LedgerTaskView, "id" | "agent">, waits: readonly OwnerWait[]): OwnerWait | null {
  const agent = bareAgent(t.agent);
  return waits.find((w) => w.taskId === t.id) ?? waits.find((w) => !w.taskId && agent !== null && !!w.fromAgent && bareAgent(w.fromAgent) === agent) ?? null;
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

/** 跨实例委托的执行者："<agent>@<peer>"，发起方 PM 建任务时写进 extra.delegate（docs/team/peer-delegation.md） */
export function delegateOf(t: Pick<LedgerTaskView, "extra">): string | null {
  const d = t.extra?.delegate;
  return typeof d === "string" && d ? d : null;
}
const unassigned = (t: LedgerTaskView): boolean => !t.agent && !delegateOf(t);

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
  if (t.stageSinceApprox === true) return false;
  if (!t.agent && delegateOf(t)) return false; // 委托给别的实例：等对方 owner、对方合并门槛按天算，不算卡住
  const d = dwellMs(t, now);
  return WAIT_STAGES.has(t.stage) && d !== null && d > STUCK_MS;
}

function isProblem(t: LedgerTaskView): boolean {
  if (t.stage === "fix" || t.stage === "blocked") return true;
  const e = t.lastEvent;
  // 检查单没过（fail）或有项查不到（unknown）都要人看：任务卡在 live，不会自己往前走
  return !!e && (e.kind === "rollback" || (e.kind === "verify" && e.data.result !== "pass"));
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

/** 「在此阶段 X」；导入推断的时间前面加 ≈；没有时长为空串 */
export function dwellText(l: Pick<LineView, "dwellMs" | "dwellApprox">, tr: Tr = zh): string {
  if (l.dwellMs === null) return "";
  return tr("在此阶段 {d}", { d: `${l.dwellApprox ? "≈" : ""}${fmtDuration(l.dwellMs, tr)}` });
}

function reviewRound(t: LedgerTaskView): number {
  return t.lastReview?.round ?? Math.max(1, t.round);
}

/** 阶段短语：写的是「现在卡在哪 / 在等谁」，不是阶段名本身 */
export function stageLabel(t: LedgerTaskView, all: readonly LedgerTaskView[], frozen: string | null, tr: Tr = zh): string {
  switch (t.stage) {
    case "spec":
      return tr(unassigned(t) ? "排队 · 等派发" : "等开工");
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
      if (t.lastEvent?.kind !== "verify" || t.lastEvent.data.result === "pass") return tr("已上线 · 等验证");
      return tr(t.lastEvent.data.result === "unknown" ? "线上验证查不到结果" : "线上验证失败");
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

export function lineOf(
  t: LedgerTaskView,
  ov: Pick<LedgerOverview, "tasks" | "meta">,
  items: ReadonlyMap<string, { oneLine: string }>,
  now: number,
  tr: Tr = zh,
  wait: OwnerWait | null = null,
): LineView {
  const frozen = frozenReason(metaOf(ov), tr);
  const base = attentionOf(t, now);
  // 出问题仍排最前；其余只要在等 owner，就归「等你」
  const att: Attention = wait && base !== "problem" ? "owner" : base;
  const dwell = dwellMs(t, now);
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    goal: goalOf(t, items),
    stage: t.stage,
    column: columnOf(t.stage, t.stageBefore),
    attention: att,
    tone: toneOf(att),
    stageLabel: stageLabel(t, ov.tasks, frozen, tr),
    dwellMs: dwell,
    dwellApprox: t.stageSinceApprox === true,
    stuck: att === "stuck",
    reason: att === "owner" && wait ? tr("等你：{t}", { t: wait.title }) : reasonOf(t, att, dwell, frozen, tr),
    agent: bareAgent(t.agent),
    delegate: t.agent ? null : delegateOf(t),
    pm: bareAgent(t.pm),
    round: t.round,
    pr: t.pr ?? null,
    stepLine: t.stepLine,
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

/** waits：这个项目里开着、等 owner 的 ask（调用方已按项目、非验收过滤）；不给 = 没有「等你」 */
export function homeView(ov: LedgerOverview, now: number, tr: Tr = zh, waits: readonly OwnerWait[] = []): HomeView {
  const items = new Map(ov.items.map((i) => [i.id, i]));
  // 没派人的 spec 是 PM 手里的排队，不画成线（PM 调度条里计数）
  const open = ov.tasks.filter((t) => !isClosed(t.stage) && !(t.stage === "spec" && unassigned(t)));
  const lines = sortLines(open.map((t) => lineOf(t, ov, items, now, tr, waitFor(t, waits))));
  const midnight = localMidnight(now);
  const pm = metaOf(ov).pms[0] ?? open.find((t) => t.pm)?.pm ?? null;
  return {
    lines,
    headline: {
      advancing: lines.length,
      problem: lines.filter((l) => l.attention === "problem").length,
      stuck: lines.filter((l) => l.attention === "stuck").length,
      owner: lines.filter((l) => l.attention === "owner").length,
    },
    todayDone: ov.tasks
      .filter((t) => (t.stage === "done" || t.stage === "verified") && (t.metrics?.endTs ?? t.updatedAt) >= midnight)
      .sort((a, b) => (a.metrics?.endTs ?? a.updatedAt) - (b.metrics?.endTs ?? b.updatedAt))
      .map((t) => t.id),
    pm: {
      pm: bareAgent(pm),
      managing: open.filter((t) => !pm || t.pm === pm).length,
      reviewing: open.filter((t) => t.stage === "review").length,
      queued: ov.tasks.filter((t) => t.stage === "spec" && unassigned(t)).map((t) => t.id),
      frozen: frozenReason(metaOf(ov), tr),
    },
  };
}
