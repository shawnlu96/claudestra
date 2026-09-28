/**
 * 内置台账的读侧（docs 10-ledger §2「推 / 读」、§4）：bridge 只读打开库、拼网页要的视图、每秒看一眼 data_version 发变更。
 * 写只有 CLI（ledger-write.ts）；bridge 不走 openLedger——那里会建表、切 WAL，bridge 不能变成写者。
 * 连接用 readwrite + create:false + query_only：纯 readonly 在 -wal / -shm 被最后一个写者删掉后打不开（SQLITE_CANTOPEN），
 * readwrite 能自己建 -shm；query_only 让任何写语句在 SQLite 层就被拒；库不存在时不会建出一个空库。
 * 本文件的语句用 db.query()（按连接缓存、close 时一并 finalize）：每秒一次的轮询不重复编译，重开时也不留半关的连接。
 */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { stageTimeline, taskMetrics, type StageEntry, type TaskMetrics } from "./ledger-metrics.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerItem, type LedgerTask, type Stage } from "./ledger-stages.js";
import { getMeta, LEDGER_PATH, LEDGER_SCHEMA_VERSION, listEvents, listItems, listTasks, getTask, toEvent, type LedgerMeta } from "./ledger-store.js";

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
}
export interface ProjectView {
  meta: LedgerMeta;
  items: LedgerItem[];
  tasks: TaskView[];
  /** 最近 PROJECT_EVENTS_LIMIT 条 target 为空的项目级事件，seq 升序 */
  projectEvents: LedgerEvent[];
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 总览只要一句原因：首行、按码点截到 120（全文在详情接口里） */
const REVIEW_TEXT_MAX = 120;

function reviewSummary(e: LedgerEvent | undefined): ReviewSummary | null {
  if (!e) return null;
  const d = e.data;
  const first = [...(e.text.split("\n").find((l) => l.trim()) ?? "").trim()];
  const text = first.length > REVIEW_TEXT_MAX ? `${first.slice(0, REVIEW_TEXT_MAX).join("")}…` : first.join("");
  return { round: numOrNull(d.round), verdict: typeof d.verdict === "string" ? d.verdict : null, p0: numOrNull(d.p0), p1: numOrNull(d.p1), p2: numOrNull(d.p2), text, ts: e.ts };
}

/** 时间线最后一段是由哪条事件开出来的（建任务或 stage，与 stageTimeline 的取点规则一致）；导入推断的时间带 approxTime */
function currentStageMark(own: readonly LedgerEvent[]): LedgerEvent | undefined {
  return own.findLast((e) => e.kind === "stage" || (e.kind === "task" && e.data.op === "new"));
}

function taskView(task: LedgerTask, own: readonly LedgerEvent[], now: number): TaskView {
  return {
    ...task,
    lastEvent: own.at(-1) ?? null,
    stageSince: stageTimeline(own, now).at(-1)?.from ?? null,
    stageSinceApprox: currentStageMark(own)?.data.approxTime === true,
    lastReview: reviewSummary(own.findLast((e) => e.kind === "review")),
    metrics: taskMetrics(task, own, now),
  };
}

/** GET /ledger/:project：事项 + 任务（每个带最近一条事件与指标）+ 最近的项目级事件；整个项目的事件只查一次 */
export function projectView(db: Database, project: string, now: number): ProjectView {
  const byTarget = new Map<string, LedgerEvent[]>();
  for (const e of listEvents(db, { project })) {
    const list = byTarget.get(e.target);
    if (list) list.push(e);
    else byTarget.set(e.target, [e]);
  }
  const recent = db.query("SELECT * FROM events WHERE project = ? AND target = '' ORDER BY seq DESC LIMIT ?").all(project, PROJECT_EVENTS_LIMIT) as Record<string, unknown>[];
  return {
    meta: getMeta(db, project),
    items: listItems(db, project),
    tasks: listTasks(db, project).map((t) => taskView(t, byTarget.get(t.id) ?? [], now)),
    projectEvents: recent.reverse().map(toEvent),
  };
}

/** GET /ledger/:project/tasks/:id：任务不在这个项目下 → null（任务 id 全局唯一，但不许借别的项目名读到） */
export function taskDetail(db: Database, project: string, id: string, now: number): { task: TaskView; events: LedgerEvent[]; timeline: StageEntry[] } | null {
  const task = getTask(db, id);
  if (!task || task.project !== project) return null;
  const events = listEvents(db, { project, target: id });
  return { task: taskView(task, events, now), events, timeline: stageTimeline(events, now) };
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

export interface FeedDeps {
  reader: LedgerReader;
  emit: (project: string) => void;
  log: (msg: string) => void;
}

/**
 * 每秒一次的变更检测：data_version 没变什么都不查；变了就查游标之后的事件属于哪些项目，逐个 emit。
 * 第一次就看到库时游标从当前最大 seq 起（网页连上 SSE 本来就全量重拉，不用补发）；库后来才出现、或文件被换掉，从 0 起。
 * 库不存在不打日志；出错只在状态切换时打一次，并关掉连接下一轮重开。
 */
export function ledgerFeedTicker(d: FeedDeps): () => void {
  let firstTick = true;
  let gen = -1;
  let dv: number | null = null;
  let seq = 0;
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
    for (const p of r.projects) d.emit(p);
  }
}
