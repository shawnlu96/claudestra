/**
 * 「今天」总览的选取。nowView = UXHOME1 的三块（等你的事、在干活、各项目），只用页面已加载的全局状态（会话列表 / 项目 / 待办 / 团队绑定）；
 * todayView（TODAY1）在它上面加各项目的台账总览与产品看板，排成五块：要你处理 → 卡住了 → 正在做 → 今天完成 → 团队与额度。
 * 不发请求、不 import react（tests/web-now-home.test.ts、tests/web-today-model.test.ts 直接测）。这里数的是「agent 个数」「事情件数」，
 * 和协作视图里按卡数的「在干活 / 在等」（count-words.ts）不是同一个口径，标签里写明单位。
 */
import type { CollabSourceChoice, BlockedReason } from "@/lib/collab-source-binding";
import type { ProductBoard } from "@/lib/api/product-board-types";
import { askWhere, proposalProjectOf, waitsOnOwner, type WebAsk } from "../asks/asks-model";
import { reviewChipView, stageChipView } from "../chat/ledger-stage";
import type { AgentSession, ProjectMeta } from "../chat/type";
import { bareAgent, fmtDuration, homeView, type LedgerOverview, type LineView } from "../collab/collab-model";
import { ownerWaits } from "../collab/owner-waits";

type Lang = "zh" | "en";
type Translate = (s: string, params?: Record<string, string | number>) => string;

/** 「等你的事」最多列几条，多的收成末行「还有 K 件」 */
export const WAIT_LIMIT = 5;
/** 「各项目」超过几个折叠成「展开全部」 */
export const PROJECT_FOLD = 6;
/** 没有卡、没有任务短名时拿用途顶上，截到这么长 */
const PURPOSE_MAX = 28;

export interface NowWait { id: string; title: string; where: string }
export interface NowWorker { name: string; label: string; doing: string; ago: string }
export interface NowProject {
  id: string;
  name: string;
  /** 这个项目里在干活的 agent 个数 */
  working: number;
  /** 待你处理件数（owner-waits.ts 口径，和点进去的协作视图顶栏同一个数） */
  waits: number;
  /** 点开的协作视图键：本机项目 id 或团队中心键；null = 团队绑定被停用，行不可点 */
  open: string | null;
  team: boolean;
  blocked: BlockedReason | null;
}
export interface NowView {
  waits: NowWait[];
  /** 等你的事总件数（列出的 + 没列出的） */
  waitTotal: number;
  workers: NowWorker[];
  projects: NowProject[];
}

export interface NowInput {
  agents: readonly AgentSession[];
  projects: readonly ProjectMeta[];
  asks: readonly WebAsk[];
}
export interface NowDeps {
  lang: Lang;
  t: Translate;
  /** 相对时间（侧栏行同一个 fmtAgo）；没有时间戳返回空串 */
  ago: (ts?: number | null) => string;
  /** 项目 → 协作视图选源（项目组入口同一个 resolveCollabSource） */
  source: (projectId: string) => CollabSourceChoice;
}

/** 来自哪个项目：提案卡取它为之开的本机项目（卡本身挂在大总管上） */
function whereOf(a: WebAsk, projects: readonly ProjectMeta[], t: Translate): string {
  const id = proposalProjectOf(a) ?? a.project;
  return id === "master" ? t("大总管") : projects.find((p) => p.id === id)?.name || id;
}

/** 在做什么：台账卡 + 阶段短语 → 在审的卡 + 轮次 → 任务短名 → 用途截断 */
export function doingOf(a: AgentSession, lang: Lang, t: Translate): string {
  if (a.ledgerTask) return `${a.ledgerTask.id} ${stageChipView(a.ledgerTask, lang).state}`;
  if (a.ledgerReview && a.ledgerReview.verdict === null) return reviewChipView(a.ledgerReview, lang, t).sentence;
  if (a.task) return a.task;
  const purpose = (a.purpose ?? "").trim();
  return purpose.length > PURPOSE_MAX ? `${purpose.slice(0, PURPOSE_MAX)}…` : purpose;
}

export function nowView({ agents, projects, asks }: NowInput, { lang, t, ago, source }: NowDeps): NowView {
  const waiting = asks.filter(waitsOnOwner).sort((x, y) => y.createdAt - x.createdAt);
  const busy = agents.filter((a) => a.busy);
  const rows = projects.map((p): NowProject => {
    const choice = source(p.id);
    const key = choice.kind === "center" ? choice.key : p.id;
    return {
      id: p.id, name: p.name || p.id,
      working: busy.filter((a) => a.projectId === p.id).length,
      waits: ownerWaits(asks, key, choice.kind === "center" ? p.id : undefined).waits.length,
      open: choice.kind === "blocked" ? null : key,
      team: choice.kind !== "local",
      blocked: choice.kind === "blocked" ? choice.reason : null,
    };
  });
  const rank = (p: NowProject) => (p.waits > 0 ? 0 : p.working > 0 ? 1 : 2);
  return {
    waits: waiting.slice(0, WAIT_LIMIT).map((a) => ({ id: a.id, title: a.title, where: whereOf(a, projects, t) })),
    waitTotal: waiting.length,
    workers: busy.map((a) => ({ name: a.name, label: a.label || t(a.displayName), doing: doingOf(a, lang, t), ago: ago(a.lastActivityTs) })),
    // sort 稳定：同一档里保持项目列表原来的顺序
    projects: rows.map((p, i) => [p, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([p]) => p),
  };
}

/** 「卡住了」最多列几条，多的收成「还有 K 条」 */
export const STUCK_LIMIT = 8;
/** 「今天完成」每个项目最多列几条 */
export const DONE_LIMIT = 5;
/** 「在做的人」最多几个头像，多的写「+K」 */
export const FACE_LIMIT = 3;

/** 要你处理一条：上行标题，下行「项目 · 模块 · 任务标题」；project = 待办挂的本机项目（看任务用），taskId 没有就不出「看任务」 */
export interface TodayWait { id: string; title: string; where: string; project: string; taskId: string | null }
/** 卡住了一行（stuckRow 出的格式） */
export interface StuckRow { id: string; project: string; title: string; projectName: string; reason: string; dwell: string; dwellMs: number | null; problem: boolean }
export interface TodayFace { name: string; label: string; doing: string }
/** 正在做下的一行模块；id = null 是「其他」（对不上模块的 agent），没有进度 */
export interface TodayModule { id: string | null; title: string; completed: number; total: number; active: number; faces: TodayFace[] }
export interface TodayProject {
  row: NowProject;
  /** 产品看板的在做模块（含末尾的「其他」）；null = 没有产品看板（退回按 agent 列）或读不了台账（只出项目行） */
  modules: TodayModule[] | null;
  /** 没有产品看板时列的 agent 行（UXHOME1 的在干活）；台账读不了的项目为空 */
  workers: NowWorker[];
  /** 有在做事项：没有的项目超过折叠数时收进「其余 K 个项目」 */
  doing: boolean;
}
export interface TodayDone { id: string; name: string; tasks: { id: string; title: string }[]; more: number }
export interface TodayView {
  waits: TodayWait[];
  waitTotal: number;
  stuck: StuckRow[];
  /** 超过 STUCK_LIMIT 的，点「还有 K 条」就地展开 */
  stuckMore: StuckRow[];
  doing: TodayProject[];
  /** 没有在做事项、又排在折叠数之外的项目 */
  rest: TodayProject[];
  /** 谁也没在干活（沿用 UXHOME1「现在没有 agent 在干活」） */
  idle: boolean;
  doneTotal: number;
  done: TodayDone[];
  /** 没有完成时间（unknownMetrics 含 todayDone）、未计入的项目数 */
  doneUnknown: number;
  /** busy = 本机在干活的会话 + 借入在别的机器上在跑的单（remote，XMACH1）；借出单不算 */
  team: { alive: number; busy: number; remote: number };
}
export interface TodayInput extends NowInput {
  /** 读到的台账总览（本机项目 id → 总览）；没读到 / 读不了的不在里面 */
  overviews: ReadonlyMap<string, LedgerOverview>;
  /** 读到的产品看板；没有看板的项目不在里面 */
  boards: ReadonlyMap<string, ProductBoard>;
  /** 台账 403 / 404 的项目：只出项目行 */
  denied: ReadonlySet<string>;
  /** 借入在别的机器上在跑的单数（GET /borrow 的 remote 里 claimed 的）；没读到 = 0 */
  remoteRunning?: number;
  now: number;
}

/** 卡住了一行的写法（PROJTABS1 的项目总览 import 它）：任务标题 · 项目名 · 一句原因（空时用阶段短语）· 停留时长（近似值前加 ≈） */
export function stuckRow(l: Pick<LineView, "id" | "title" | "reason" | "stageLabel" | "dwellMs" | "dwellApprox" | "attention">, project: string, projectName: string,
  tr: Translate): StuckRow {
  const dwell = l.dwellMs === null ? "" : `${l.dwellApprox ? "≈" : ""}${fmtDuration(l.dwellMs, tr)}`;
  return { id: l.id, project, title: l.title, projectName, reason: l.reason || l.stageLabel, dwell, dwellMs: l.dwellMs, problem: l.attention === "problem" };
}

/** 任务号 → 所在模块（产品看板 cards 的任务号） */
function moduleIndex(board: ProductBoard | undefined): Map<string, { id: string; title: string }> {
  const out = new Map<string, { id: string; title: string }>();
  for (const f of board?.features ?? []) for (const c of f.cards ?? []) out.set(c.id, { id: f.id, title: f.title });
  return out;
}

function todayWaits(waiting: readonly WebAsk[], input: TodayInput, t: Translate): TodayWait[] {
  return waiting.slice(0, WAIT_LIMIT).map((a) => {
    const project = proposalProjectOf(a) ?? a.project;
    const where = askWhere({ ...a, taskId: null, taskTitle: undefined }, input.projects, t);
    const task = a.taskId ? input.overviews.get(project)?.tasks.find((x) => x.id === a.taskId) : undefined;
    const mod = a.taskId ? moduleIndex(input.boards.get(project)).get(a.taskId)?.title : undefined;
    const title = a.taskTitle || task?.title || a.taskId;
    return { id: a.id, title: a.title, where: [where, mod, title].filter(Boolean).join(" · "), project, taskId: a.taskId };
  });
}

function faceOf(name: string, agents: readonly AgentSession[], line: LineView | undefined, lang: Lang, t: Translate): TodayFace {
  const a = agents.find((x) => bareAgent(x.name) === name);
  const doing = a ? doingOf(a, lang, t) : line ? `${line.id} ${line.stageLabel}` : "";
  return { name, label: a ? a.label || t(a.displayName) : name, doing };
}

/** 一个项目的在做模块：status=active 且 counts.active>0；人按总览任务的执行者、任务号对到模块，对不上的进「其他」 */
function modulesOf(id: string, board: ProductBoard, lines: readonly LineView[], agents: readonly AgentSession[], lang: Lang, t: Translate): TodayModule[] {
  const index = moduleIndex(board);
  const faces = new Map<string, Map<string, TodayFace>>();
  const add = (key: string, name: string, line?: LineView) => {
    const m = faces.get(key) ?? new Map<string, TodayFace>();
    if (!m.has(name)) m.set(name, faceOf(name, agents, line, lang, t));
    faces.set(key, m);
  };
  const placed = new Set<string>();
  for (const l of lines) {
    const f = l.agent ? index.get(l.id) : undefined;
    if (f && l.agent) { add(f.id, l.agent, l); placed.add(l.agent); }
  }
  const others = [...lines.filter((l) => l.agent && !placed.has(l.agent)).map((l) => [l.agent!, l] as const),
    ...agents.filter((a) => a.busy && a.projectId === id).map((a) => [bareAgent(a.name)!, undefined] as const)];
  for (const [name, line] of others) if (!placed.has(name)) add("", name, line);
  const rows = board.features.filter((f) => f.status === "active" && f.counts.active > 0).map((f): TodayModule => ({
    id: f.id, title: f.title, completed: f.counts.completed, total: f.counts.total, active: f.counts.active, faces: [...(faces.get(f.id)?.values() ?? [])],
  }));
  const rest = faces.get("");
  return rest?.size ? [...rows, { id: null, title: t("其他"), completed: 0, total: 0, active: 0, faces: [...rest.values()] }] : rows;
}

function todayDone(input: TodayInput, t: Translate): Pick<TodayView, "done" | "doneTotal" | "doneUnknown"> {
  const done: TodayDone[] = [];
  let doneUnknown = 0;
  for (const p of input.projects) {
    const ov = input.overviews.get(p.id);
    if (!ov || input.denied.has(p.id)) continue;
    if (ov.unknownMetrics?.includes("todayDone")) { doneUnknown++; continue; }
    const ids = homeView(ov, input.now, t).todayDone;
    if (!ids.length) continue;
    const tasks = ids.map((id) => ({ id, title: ov.tasks.find((x) => x.id === id)?.title || id }));
    done.push({ id: p.id, name: p.name || p.id, tasks: tasks.slice(0, DONE_LIMIT), more: Math.max(0, tasks.length - DONE_LIMIT) });
  }
  return { done, doneTotal: done.reduce((n, d) => n + d.tasks.length + d.more, 0), doneUnknown };
}

/** 五块的数据：排序、截断、合计都在这里；项目行、在干活、等你的事的口径照 nowView */
/** 借出 worker 落在这个项目里（src/lib/lend-deps.ts 的 LEND_PROJECT） */
const LEND_PROJECT = "lend";

export function todayView(input: TodayInput, deps: NowDeps): TodayView {
  const { lang, t } = deps;
  const base = nowView(input, deps);
  const remote = input.remoteRunning ?? 0;
  // 借出单（别人在我机器上跑的，lend 项目里的会话）不算「在干活」，它们在团队与额度里单独列
  const own = input.agents.filter((a) => a.busy && a.projectId !== LEND_PROJECT).length;
  const waiting = input.asks.filter(waitsOnOwner).sort((x, y) => y.createdAt - x.createdAt);
  const stuck: StuckRow[] = [];
  const doing: TodayProject[] = [];
  for (const row of base.projects) {
    const ov = input.denied.has(row.id) ? undefined : input.overviews.get(row.id);
    const lines = ov ? homeView(ov, input.now, t, ownerWaits(input.asks, row.id, undefined).waits).lines : [];
    for (const l of lines) if (l.attention === "problem" || l.attention === "stuck") stuck.push(stuckRow(l, row.id, row.name, t));
    const board = ov ? input.boards.get(row.id) : undefined;
    // 台账读不了（403 / 404）：只出项目行，不列 agent；没有产品看板：退回按 agent 列
    const denied = input.denied.has(row.id);
    const workers = denied ? [] : input.agents.filter((a) => a.busy && a.projectId === row.id).map((a) => base.workers.find((w) => w.name === a.name)!);
    const modules = board ? modulesOf(row.id, board, lines, input.agents, lang, t) : null;
    doing.push({ row, modules, workers, doing: modules ? modules.length > 0 : workers.length > 0 });
  }
  stuck.sort((a, b) => Number(b.problem) - Number(a.problem) || (b.dwellMs ?? -1) - (a.dwellMs ?? -1));
  const shown = doing.filter((p, i) => p.doing || i < PROJECT_FOLD);
  return {
    waits: todayWaits(waiting, input, t),
    waitTotal: waiting.length,
    stuck: stuck.slice(0, STUCK_LIMIT),
    stuckMore: stuck.slice(STUCK_LIMIT),
    doing: shown,
    rest: doing.filter((p) => !shown.includes(p)),
    idle: own === 0 && !remote && doing.every((p) => !p.doing),
    ...todayDone(input, t),
    team: { alive: input.agents.filter((a) => a.status === "active").length, busy: own + remote, remote },
  };
}

/** 团队块第一行只数本机：busy 里减去借入在别的机器上跑的单（那些归下面的机器行） */
export const aliveLine = (team: TodayView["team"], tr: Translate): string =>
  tr("本机 {n} 个 agent 活着 · {m} 个在干活", { n: team.alive, m: team.busy - team.remote });

/** 「N 个 agent 在干活」：有借入在别的机器上跑时补「其中 M 个在别的机器」（侧栏条与「正在做」同一句） */
export const busyLine = (team: Pick<TodayView["team"], "busy" | "remote">, tr: Translate): string => team.remote
  ? tr("{n} 个 agent 在干活 · 其中 {m} 个在别的机器", { n: team.busy, m: team.remote })
  : tr("{n} 个 agent 在干活", { n: team.busy });
