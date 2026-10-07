/**
 * 内置台账的读侧（docs 10-ledger §2「推 / 读」、§4）：bridge 只读打开库、拼网页要的视图、每秒看一眼 data_version 发变更。
 * 写只有 CLI（ledger-write.ts）；bridge 不走 openLedger——那里会建表、切 WAL，bridge 不能变成写者。
 * 连接用 readwrite + create:false + query_only：纯 readonly 在 -wal / -shm 被最后一个写者删掉后打不开（SQLITE_CANTOPEN），
 * readwrite 能自己建 -shm；query_only 让任何写语句在 SQLite 层就被拒；库不存在时不会建出一个空库。
 * 本文件的语句用 db.query()（按连接缓存、close 时一并 finalize）：每秒一次的轮询不重复编译，重开时也不留半关的连接。
 */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { depViews, reviewBranches, type DepView, type ReviewBranches } from "./ledger-deps.js";
import { stageTimeline, type StageEntry } from "./ledger-metrics.js";
import { compactStage, doneCard, eventsByTarget, liveCard, overviewCard, taskView, type OverviewItem, type OverviewTask, type TaskView } from "./ledger-read-cards.js";
import { dayStartOf, doneWindow, type DoneRest } from "./ledger-read-done.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask, type ReviewVerdict, type Stage } from "./ledger-stages.js";
import { auditChangedProjects, openFindings, type StoredFinding } from "./ledger-audit-store.js";
import { listSteps, stepsByTask, type TaskStep } from "./ledger-steps.js";
import { stepLineInfo, type StepLineInfo } from "./ledger-step-line.js";
import { RETIRE_STAGES, taskSessionLinks } from "./scheduler-sessions.js";
import { getMeta, LEDGER_PATH, LEDGER_SCHEMA_VERSION, listDeps, listEvents, listItems, listTasks, getTask, toEvent, type LedgerMeta } from "./ledger-store.js";

export { clipFirstLine } from "./ledger-read-cards.js";

/** 读连接等锁的上限：WAL 下读不等写，只有写者刚建库、还没切 WAL 的那一瞬会撞上；宁可这一轮报 busy 也不卡住 bridge */
const READ_BUSY_TIMEOUT_MS = 200;
/** 总览里带的项目级事件（冻结 / 解冻 / meta）条数 */
export const PROJECT_EVENTS_LIMIT = 20;

/**
 * 只读连接的持有者：按路径开一次，文件被换掉（dev / inode 变了）或删掉就关掉重开。
 * generation 在打开的是另一份文件时 +1，feed 据此把 seq 游标归零。
 */
export class LedgerReader {
  private db: Database | null = null;
  private fileId: string | null = null;
  generation = 0;
  constructor(readonly path: string = LEDGER_PATH) {}

  /** 当前可读连接；库不存在或写者还没建完表 → null。打开 / 读版本出错直接抛，调用方决定怎么报 */
  get(): Database | null {
    let id: string;
    try {
      const st = statSync(this.path);
      id = `${st.dev}:${st.ino}`;
    } catch {
      // 库文件不在 = 还没人写过台账（新装机）或被删了：按「没有台账」处理，不是错误
      this.close();
      return null;
    }
    if (this.db && id === this.fileId) return this.db;
    this.close();
    const db = new Database(this.path, { readwrite: true, create: false });
    try {
      db.exec("PRAGMA query_only = ON");
      db.exec(`PRAGMA busy_timeout = ${READ_BUSY_TIMEOUT_MS}`);
      const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (v < 1) {
        db.close(); // 写者正在建表：这一轮当作没有，下一轮再开
        return null;
      }
      // 库比代码新 = CLI 先升级了、bridge 还没重启：只读照样能读（迁移只追加），提醒一次该重启了；同一份文件只开一次，不会刷屏
      if (v > LEDGER_SCHEMA_VERSION && id !== this.fileId) console.warn(`⚠️ 台账库版本 ${v} 比 bridge 的 ${LEDGER_SCHEMA_VERSION} 新：重启 bridge 以跟上新字段`);
    } catch (e) {
      db.close();
      throw e;
    }
    if (id !== this.fileId) this.generation++;
    this.db = db;
    this.fileId = id;
    return db;
  }

  /** 当前打开的库文件标识（dev:ino）；没打开为 null。换了文件（恢复备份、备机接管）就变 */
  get file(): string | null {
    return this.fileId;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

function dataVersion(db: Database): number {
  return (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
}

function maxEventSeq(db: Database): number {
  return (db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m;
}

/** seq 之后写过事件的项目。每个写函数都在同一事务里追加一条事件，所以「哪个项目变了」看事件就够 */
function changedProjects(db: Database, afterSeq: number): { projects: string[]; lastSeq: number } {
  const rows = db.query("SELECT project, MAX(seq) AS m FROM events WHERE seq > ? GROUP BY project ORDER BY project").all(afterSeq) as { project: string; m: number }[];
  return { projects: rows.map((r) => r.project), lastSeq: rows.reduce((m, r) => Math.max(m, r.m), afterSeq) };
}

export interface ProjectView {
  meta: LedgerMeta;
  items: OverviewItem[];
  tasks: OverviewTask[];
  /** 项目的依赖边，带推导值与最终状态 */
  deps: DepView[];
  /** 最近 PROJECT_EVENTS_LIMIT 条 target 为空的项目级事件，seq 升序 */
  projectEvents: LedgerEvent[];
  /** 巡检发现、还没解决的「可能漏了」（lib/ledger-audit.ts）；库还没有 audit_findings 表 = 空 */
  audit: StoredFinding[];
  /** 已完成卡只带窗口（ledger-read-done.ts）：更早的从这个游标起翻 GET /ledger/:project/done；null = 没有更早的 */
  doneCursor: string | null;
  /** 窗口外已完成卡的聚合计数 */
  doneRest: DoneRest;
}

/** GET /ledger/:project：事项 + 任务（每个带最近一条事件与指标）+ 最近的项目级事件；整个项目的事件只查一次 */
export function projectView(db: Database, project: string, now: number, clientDayStart: number | null = null): ProjectView {
  return db.transaction(() => projectViewSnapshot(db, project, now, dayStartOf(now, clientDayStart))).deferred();
}

function projectViewSnapshot(db: Database, project: string, now: number, dayStart: number): ProjectView {
  const byTarget = eventsByTarget(listEvents(db, { project }));
  // ask 族事件不进项目级列表（isAskEvent 同一口径）：25 条没挂任务的 ask 就能把这 20 条挤满
  const recent = db
    .query(`SELECT * FROM events WHERE project = ? AND target = '' AND kind NOT IN ('ask', 'ask_expire', 'ask_cancel', 'ask_reopen')
      AND NOT (kind = 'decision' AND json_extract(data, '$.askId') IS NOT NULL) ORDER BY seq DESC LIMIT ?`)
    .all(project, PROJECT_EVENTS_LIMIT) as Record<string, unknown>[];
  const tasks = listTasks(db, project);
  const deps = depViews(listDeps(db, project), tasks);
  const rows = stepsByTask(db);
  const views = tasks.map((t) => taskView(t, byTarget.get(t.id) ?? [], now, deps));
  const win = doneWindow(views.filter((v) => compactStage(v.stage)), deps, dayStart);
  const visible = new Set(views.filter((v) => !compactStage(v.stage) || win.keep.has(v.id)).map((v) => v.id));
  const line = (v: TaskView) => stepLineInfo(v, rows.get(v.id) ?? [], byTarget.get(v.id) ?? []);
  return {
    meta: getMeta(db, project),
    items: listItems(db, project).map((i) => ({ id: i.id, title: i.title, oneLine: i.oneLine })),
    tasks: views.flatMap((v) => (!compactStage(v.stage) ? [liveCard(v, line(v))] : win.keep.has(v.id) ? [doneCard(v, win.today.has(v.id) ? line(v) : null)] : [])).map(overviewCard),
    doneCursor: win.cursor,
    doneRest: win.rest,
    deps: deps.filter((d) => visible.has(d.from) && visible.has(d.to)),
    projectEvents: recent.reverse().map(toEvent),
    audit: openFindings(db, project),
  };
}

/** 进入当前工作阶段（blocked 时是进 blocked 前那个）的那条 stage 事件的来处 */
function enteredFrom(task: LedgerTask, events: readonly LedgerEvent[]): Stage | null {
  const at = task.stage === "blocked" ? task.stageBefore : task.stage;
  const e = events.findLast((x) => x.kind === "stage" && x.data.to === at);
  return typeof e?.data.from === "string" ? (e.data.from as Stage) : null;
}

export interface TaskDetail {
  task: TaskView;
  events: LedgerEvent[];
  timeline: StageEntry[];
  /** 进边（它等谁）与出边（谁等它） */
  deps: { in: DepView[]; out: DepView[] };
  /** 审查分叉：现算，不存边 */
  reviewBranches: ReviewBranches;
  /** 步骤化台账（ledger-steps.ts）：库里的行 + 老字段推出来的 */
  steps: TaskStep[];
  /** 步骤线（T51）：steps 加当前这一步、是否在等对方 owner */
  stepLine: StepLineInfo;
  /** Durable active session refs keep task workers reachable even before their first review event. */
  sessions: ReturnType<typeof taskSessionLinks>;
}

/** GET /ledger/:project/tasks/:id：任务不在这个项目下 → null（任务 id 全局唯一，但不许借别的项目名读到） */
export function taskDetail(db: Database, project: string, id: string, now: number): TaskDetail | null {
  const task = getTask(db, id);
  if (!task || task.project !== project) return null;
  const events = listEvents(db, { project, target: id });
  const deps = depViews(listDeps(db, project), listTasks(db, project));
  const view = taskView(task, events, now, deps);
  return {
    task: view,
    events,
    timeline: stageTimeline(events, now),
    deps: { in: deps.filter((d) => d.to === id), out: deps.filter((d) => d.from === id) },
    reviewBranches: reviewBranches(task, view.lastReview, enteredFrom(task, events)),
    sessions: taskSessionLinks(db, task.id),
    ...((line) => ({ steps: line.steps, stepLine: line }))(stepLineInfo(task, listSteps(db, task.id), events)),
  };
}

export interface LedgerTaskRef {
  id: string;
  stage: Stage;
  round: number;
}

/** agent（去掉 agent- 前缀的裸名）→ 它执行中的任务；同一 agent 有多个未完成任务时取最近更新的那个 */
export function activeTasksByAgent(db: Database): Map<string, LedgerTaskRef> {
  const marks = TERMINAL_STAGES.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT id, stage, round, agent FROM tasks WHERE agent IS NOT NULL AND agent != '' AND stage NOT IN (${marks}) ORDER BY updatedAt, id`)
    .all(...TERMINAL_STAGES) as { id: string; stage: Stage; round: number; agent: string }[];
  const out = new Map<string, LedgerTaskRef>();
  for (const r of rows) out.set(r.agent.replace(/^agent-/, ""), { id: r.id, stage: r.stage, round: r.round });
  return out;
}

export interface LedgerReviewRef {
  id: string;
  round: number;
  /** null = 已派审、还没交结论 */
  verdict: ReviewVerdict | null;
  p0: number;
  p1: number;
  p2: number;
}

const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** 结论事件只有审查员名、没有 kind：带 @（peer）或 local:（人）的不算本机审查员 */
const localReviewer = (who: unknown): who is string => typeof who === "string" && !!who && !who.includes("@") && !who.startsWith("local:");
/** 派审 / 绑定已由调用方按 kind / transport / 出借意图判过本机：名字原样收（本机 agent 名可以带 @，见 ledger-steps.ts stepPeer） */
const inReview = (local: boolean, who: unknown, id: string, round: number): [string, LedgerReviewRef] | null =>
  local && typeof who === "string" && who ? [who, { id, round, verdict: null, p0: 0, p1: 0, p2: 0 }] : null;

/** 派审意图（plan）只有收件人名：它是不是本机，看同卡此前最近一次 reviewer bind（transport）/ 派审步骤（executorKind）给这个名字定的身份 */
type ReviewerIdentity = { agent: unknown; local: boolean };
const identityOf = (e: LedgerEvent): ReviewerIdentity | null =>
  e.kind === "step" ? { agent: e.data.executor, local: e.data.executorKind === "agent" }
    : e.kind === "scheduler" && e.data.op === "session_bind" ? { agent: e.data.agent, local: e.data.transport !== "peer" } : null;

/**
 * 一条派审 / 结论 / 调度器审查员会话事件 → 本机审查员裸名 + 它对这张卡的状态；taskRound = 卡当前轮次（bind 事件不带轮次）。
 * 调度器：reviewer session_bind / 派审意图（plan action=review，轮次在意图 id 的 :rN:）→ 在审；reviewer session_retire → 不再显示。
 * planBy = 派审意图之前这张卡最近的审查员身份；没有、名字对不上或是远端，意图都不算本机（不能从名字推）。
 */
function reviewOf(e: LedgerEvent, taskRound: number, planBy: ReviewerIdentity | undefined): [string, LedgerReviewRef] | null {
  const d = e.data;
  const round = count(d.round);
  if (e.kind === "step") return inReview(d.executorKind === "agent", d.executor, e.target, round);
  if (e.kind === "scheduler") {
    if (d.op === "session_bind") return inReview(identityOf(e)!.local, d.agent, e.target, taskRound);
    if (d.op === "plan") return inReview(!!planBy?.local && planBy.agent === d.recipient, d.recipient, e.target, Number(/:r(\d+):/.exec(String(d.id))?.[1] ?? taskRound));
    return null; // session_retire
  }
  const verdict = (["pass", "changes", "block"] as const).find((v) => v === d.verdict);
  return verdict && localReviewer(d.reviewer) ? [d.reviewer, { id: e.target, round, verdict, p0: count(d.p0), p1: count(d.p1), p2: count(d.p2) }] : null;
}

/**
 * 审查员（裸名）→ 它在审 / 审完的卡。审查员不绑卡，关系只在事件里：派审（step assign review / final_review）、结论（review），
 * 自动卡另有调度器的 reviewer 会话绑定 / 派审意图 / 会话退役（kind=scheduler，作者那边的不收）。
 * 每张没验收完（verified / done / cancelled 之外）的卡只看最后一条这类事件：派审 / 绑定 → 那个审查员「在审」；结论 → 「审完」带结论；退役 → 没人。卡改派给别人或结束，旧的就不再显示。
 * 同一 agent 挂着几张：在审的优先于审完的，同类取最新。tests/ledger-read-reviews*.test.ts
 */
export function activeReviewsByAgent(db: Database): Map<string, LedgerReviewRef> {
  const marks = RETIRE_STAGES.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT e.*, t.round AS taskRound FROM events e JOIN tasks t ON t.id = e.target WHERE t.stage NOT IN (${marks}) AND (e.kind = 'review'
      OR (e.kind = 'step' AND json_extract(e.data, '$.op') = 'assign' AND json_extract(e.data, '$.step') IN ('review', 'final_review'))
      OR (e.kind = 'scheduler' AND (json_extract(e.data, '$.op') = 'plan' AND json_extract(e.data, '$.action') = 'review'
        OR json_extract(e.data, '$.op') IN ('session_bind', 'session_retire') AND json_extract(e.data, '$.role') = 'reviewer'))) ORDER BY e.seq`)
    .all(...RETIRE_STAGES) as Record<string, unknown>[];
  const lastByTask = new Map<string, { e: LedgerEvent; taskRound: number; planBy?: ReviewerIdentity }>();
  const identity = new Map<string, ReviewerIdentity>();
  for (const r of rows) {
    const e = toEvent(r);
    // 先删再设：Map 按首次插入排序，这样遍历顺序 = 各卡最后一条事件的 seq 顺序（「同类取最新」靠它）
    lastByTask.delete(e.target);
    lastByTask.set(e.target, { e, taskRound: count(r.taskRound), planBy: identity.get(e.target) });
    const id = identityOf(e);
    if (id) identity.set(e.target, id);
  }
  const out = new Map<string, LedgerReviewRef>();
  for (const { e, taskRound, planBy } of lastByTask.values()) {
    const hit = reviewOf(e, taskRound, planBy);
    if (!hit) continue;
    const name = hit[0].replace(/^agent-/, "");
    const prev = out.get(name);
    if (!prev || prev.verdict !== null || hit[1].verdict === null) out.set(name, hit[1]);
  }
  return out;
}

export interface FeedDeps {
  reader: LedgerReader;
  emit: (project: string) => void;
  log: (msg: string) => void;
}

/**
 * 每秒一次的变更检测：data_version 没变什么都不查；变了就查游标之后的事件属于哪些项目，逐个 emit。
 * 巡检结果不写事件（audit_findings 表），另用 changedAt 游标查，两边的项目合并后各 emit 一次。
 * 第一次就看到库时游标从当前最大 seq 起（网页连上 SSE 本来就全量重拉，不用补发）；库后来才出现、或文件被换掉，从 0 起。
 * 库不存在不打日志；出错只在状态切换时打一次，并关掉连接下一轮重开。
 */
export function ledgerFeedTicker(d: FeedDeps): () => void {
  let firstTick = true;
  let gen = -1;
  let dv: number | null = null;
  let seq = 0;
  let auditAt = 0;
  let failing = false;
  return () => {
    const first = firstTick;
    firstTick = false;
    try {
      const db = d.reader.get();
      if (!db) {
        dv = null;
        return;
      }
      let baseline = false;
      if (d.reader.generation !== gen) {
        gen = d.reader.generation;
        baseline = first;
        seq = first ? maxEventSeq(db) : 0;
        auditAt = first ? auditChangedProjects(db, 0).last : 0;
        dv = null;
      }
      const v = dataVersion(db);
      if (v !== dv) {
        dv = v;
        if (!baseline) emitSince(db);
      }
      if (failing) d.log("📒 台账变更检测恢复");
      failing = false;
    } catch (e) {
      if (!failing) d.log(`⚠️ 台账变更检测出错（恢复前不再重复报）: ${(e as Error).message}`);
      failing = true;
      d.reader.close();
      dv = null; // 恢复后按游标补查一次：出错期间的写入不能丢，没写过就什么也不发
    }
  };

  function emitSince(db: Database): void {
    if (maxEventSeq(db) < seq) seq = 0; // 库被换成更短的一份（恢复备份）：全部重发一次
    const r = changedProjects(db, seq);
    seq = r.lastSeq;
    const a = auditChangedProjects(db, auditAt);
    auditAt = a.last;
    for (const p of new Set([...r.projects, ...a.projects])) d.emit(p);
  }
}
