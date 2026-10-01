/**
 * 子 DAG 看板的只读投影（i28-L4，docs/design/feature-dag.md「看板读接口」）：DAG 图与进度图共用一份快照。
 * 节点 = dagSnapshot 的 NodeView 再叠上卡的三态 / 谁在做 / 节点内进度条；agent 行从同一批节点反推，两张图因此对得上。
 * 只出本项目的卡：projectNodes 按 taskId 现读不核项目，这里把别的项目的卡和找不到的卡一律当 missing，字段全空。
 * 调用方负责在一个 deferred 读事务里调（schedulerProjectView 嵌套进去是 SAVEPOINT，读的是同一份快照）。只读库，不写。
 */
import type { Database } from "bun:sqlite";
import { dagSnapshot } from "./ledger-dag-view.js";
import { nodePhase, type NodePhase } from "./ledger-dag-rules.js";
import { getPendingProposal, type DagProposal, type DagVersion, type Feature, type NodeView } from "./ledger-feature.js";
import { stageTimeline } from "./ledger-metrics.js";
import { schedulerProjectView, type SchedulerTaskView } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, StepName } from "./ledger-stages.js";
import { stepLineInfo, type StepLineInfo } from "./ledger-step-line.js";
import { stepAtStage, stepsByTask, type TaskStep } from "./ledger-steps.js";
import { getMeta, listEvents, listTasks } from "./ledger-store.js";

export type VersionMeta = Omit<DagVersion, "featureId" | "nodes">;
export type PendingMeta = VersionMeta & { seq: number; baseVersion: number; askId: string };

export interface BoardHandler {
  role: "executor" | "reviewer" | "pm" | "dispatcher" | "owner";
  agent: string | null;
  since: number;
}

export interface BoardNode extends NodeView {
  phase: NodePhase;
  round: number | null;
  /** 只有进行中、卡在本项目里的节点有；agent 为空时（审查员是子 agent 等）用当前那一步的执行人补 */
  handler: BoardHandler | null;
  stepLine: { active: { step: StepName; round: number } | null; steps: { step: StepName; round: number; state: string }[] } | null;
  /** 当前阶段的起点（= GET /ledger/:project 的 stageSince）；没开始和已完成一律 null，不计时 */
  since: number | null;
  pr: string | null;
  branch: string | null;
}

export interface FeatureCard {
  id: string;
  title: string;
  status: Feature["status"];
  ownerWords: string;
  currentVersion: number;
  version: VersionMeta | null;
  pending: PendingMeta | null;
  /** missing 单独计，不算进 active：四项相加 = total */
  counts: { total: number; done: number; active: number; idle: number; missing: number };
  lastActivityAt: number | null;
  nodes: BoardNode[];
}

export interface ProgressRow {
  agent: string;
  pm: boolean;
  work: { featureId: string; nodeKey: string; taskId: string; role: string; step: StepName | null; round: number | null; since: number }[];
  offGraph: { taskId: string; stage: string; role: string; since: number }[];
}

export interface DagBoard {
  asOfSeq: number;
  features: FeatureCard[];
  agents: ProgressRow[];
}

/** 一个请求读一次的本项目事实：卡、各卡事件、步骤行、调度器视图（handler 的唯一来源） */
export interface BoardCtx {
  db: Database;
  project: string;
  now: number;
  asOfSeq: number;
  tasks: Map<string, LedgerTask>;
  events: Map<string, LedgerEvent[]>;
  steps: Map<string, TaskStep[]>;
  sched: Map<string, SchedulerTaskView>;
  lines: Map<string, StepLineInfo>;
}

const FEATURE_TABLES = ["features", "dag_versions", "dag_proposals", "dag_bindings"];

/** bridge 的只读连接不跑迁移：老库没有 feature 表时当作「没有 feature」，不报错 */
export function hasFeatureSchema(db: Database): boolean {
  const n = db.query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${FEATURE_TABLES.map(() => "?").join(",")})`)
    .get(...FEATURE_TABLES) as { n: number };
  return n.n === FEATURE_TABLES.length;
}

export function boardContext(db: Database, project: string, now: number): BoardCtx {
  const view = schedulerProjectView(db, project);
  const events = new Map<string, LedgerEvent[]>();
  for (const e of listEvents(db, { project })) {
    const list = events.get(e.target);
    if (list) list.push(e);
    else events.set(e.target, [e]);
  }
  return {
    db, project, now, asOfSeq: view.asOfSeq, events, steps: stepsByTask(db), lines: new Map(),
    tasks: new Map(listTasks(db, project).map((t) => [t.id, t])),
    sched: new Map(view.tasks.map((t) => [t.taskId, t])),
  };
}

function lineOf(ctx: BoardCtx, task: LedgerTask): StepLineInfo {
  let info = ctx.lines.get(task.id);
  if (!info) {
    info = stepLineInfo(task, ctx.steps.get(task.id) ?? [], ctx.events.get(task.id) ?? []);
    ctx.lines.set(task.id, info);
  }
  return info;
}

/** schedulerProjectView 的 handler；agent 为空且是执行者 / 审查员时，用 stepAtStage 认出的那一步的执行人补（同 team-activity） */
export function handlerOf(ctx: BoardCtx, task: LedgerTask): BoardHandler | null {
  const h = ctx.sched.get(task.id)?.handler;
  if (!h) return null;
  const fill = !h.agent && (h.role === "executor" || h.role === "reviewer") ? stepAtStage(lineOf(ctx, task).steps, task)?.executor ?? null : null;
  return { role: h.role, agent: h.agent ?? fill, since: h.since };
}

/** 卡在本项目里才算数；别的项目的卡、找不到的卡 = null（调用方按 missing 处理） */
export const ownTask = (ctx: BoardCtx, taskId: string | null): LedgerTask | null => (taskId ? ctx.tasks.get(taskId) ?? null : null);

export function phaseNow(ctx: BoardCtx, taskId: string | null): NodePhase {
  return nodePhase(taskId, ownTask(ctx, taskId)?.stage ?? null);
}

/** dagSnapshot 的投影叠上卡的现况；别的项目的卡清成 missing，依赖它的节点也不算 ready */
export function boardNodes(ctx: BoardCtx, views: readonly NodeView[]): BoardNode[] {
  const foreign = new Set(views.filter((v) => v.taskId && !ownTask(ctx, v.taskId)).map((v) => v.key));
  return views.map((v): BoardNode => {
    const task = ownTask(ctx, v.taskId);
    const phase = nodePhase(v.taskId, task?.stage ?? null);
    const lost = foreign.has(v.key);
    const base: NodeView = lost ? { ...v, status: null, title: null, satisfied: false, ready: false, missing: true }
      : { ...v, ready: v.ready && !v.deps.some((d) => foreign.has(d)) };
    if (!task) return { ...base, phase, round: null, handler: null, stepLine: null, since: null, pr: null, branch: null };
    const info = lineOf(ctx, task);
    const active = phase === "active";
    return {
      ...base, phase, round: task.round, handler: active ? handlerOf(ctx, task) : null,
      stepLine: { active: info.active, steps: info.steps.map((s) => ({ step: s.step, round: s.round, state: s.state })) },
      since: active ? stageTimeline(ctx.events.get(task.id) ?? [], ctx.now).at(-1)?.from ?? null : null,
      pr: task.pr, branch: task.branch,
    };
  });
}

export function versionMeta(v: Omit<DagVersion, "nodes">): VersionMeta {
  return {
    version: v.version, reasonKind: v.reasonKind, reasonText: v.reasonText, proposedBy: v.proposedBy, approvedBy: v.approvedBy,
    createdAt: v.createdAt, cancels: v.cancels, scopeChange: v.scopeChange, askId: v.askId,
  };
}

export function pendingMeta(p: Omit<DagProposal, "nodes">): PendingMeta {
  return { ...versionMeta({ ...p, approvedBy: null }), seq: p.seq, baseVersion: p.baseVersion, askId: p.askId };
}

export function listProjectFeatures(db: Database, project: string): Feature[] {
  return db.query("SELECT * FROM features WHERE project = ? ORDER BY id").all(project) as Feature[];
}

/** feature 卡片：当前版并上绑卡（dagSnapshot）+ 现况；没建图 = version null、nodes []；pending 只给元信息，不并进 nodes */
export function featureCard(ctx: BoardCtx, f: Feature): FeatureCard {
  const snap = f.currentVersion ? dagSnapshot(ctx.db, f) : null;
  const pending = snap ? snap.pending : getPendingProposal(ctx.db, f.id);
  const nodes = snap ? boardNodes(ctx, snap.version.nodes) : [];
  const count = (p: NodePhase) => nodes.filter((n) => !n.missing && n.phase === p).length;
  const touched = nodes.map((n) => ownTask(ctx, n.taskId)?.updatedAt).filter((t): t is number => typeof t === "number");
  return {
    id: f.id, title: f.title, status: f.status, ownerWords: f.ownerWords, currentVersion: f.currentVersion,
    version: snap ? versionMeta(snap.version) : null, pending: pending ? pendingMeta(pending) : null,
    counts: { total: nodes.length, done: count("done"), active: count("active"), idle: count("idle"), missing: nodes.filter((n) => n.missing).length },
    lastActivityAt: touched.length ? Math.max(...touched) : null, nodes,
  };
}

const STATUS_ORDER: Record<Feature["status"], number> = { active: 0, paused: 1, done: 2, dropped: 3 };

/** 行名：去掉 agent- 前缀；peer 执行者 <agent>@<peer> 只去名字那一段的前缀 */
export function rowName(agent: string): string {
  const at = agent.lastIndexOf("@");
  return at > 0 ? `${agent.slice(0, at).replace(/^agent-/, "")}${agent.slice(at)}` : agent.replace(/^agent-/, "");
}

/** 进度图的行：节点上的 handler 一条不漏地进对应行；不在任何当前版里、却有人在做的卡进 offGraph；PM 名单每人一行 */
export function progressRows(ctx: BoardCtx, features: readonly FeatureCard[]): ProgressRow[] {
  const rows = new Map<string, ProgressRow>();
  const row = (agent: string) => {
    const name = rowName(agent);
    let r = rows.get(name);
    if (!r) rows.set(name, (r = { agent: name, pm: false, work: [], offGraph: [] }));
    return r;
  };
  const pms = getMeta(ctx.db, ctx.project).pms;
  for (const pm of pms) row(pm).pm = true;
  const onGraph = new Set<string>();
  for (const f of features) {
    for (const n of f.nodes) {
      if (n.taskId && !n.missing) onGraph.add(n.taskId);
      if (!n.handler?.agent || !n.taskId) continue;
      row(n.handler.agent).work.push({ featureId: f.id, nodeKey: n.key, taskId: n.taskId, role: n.handler.role,
        step: n.stepLine?.active?.step ?? null, round: n.stepLine?.active?.round ?? n.round, since: n.handler.since });
    }
  }
  for (const task of ctx.tasks.values()) {
    if (onGraph.has(task.id) || phaseNow(ctx, task.id) !== "active") continue;
    const h = handlerOf(ctx, task);
    if (h?.agent) row(h.agent).offGraph.push({ taskId: task.id, stage: task.stage, role: h.role, since: h.since });
  }
  const first = (r: ProgressRow) => Math.min(...r.work.map((w) => w.since), ...r.offGraph.map((o) => o.since));
  const pmIndex = (r: ProgressRow) => pms.findIndex((p) => rowName(p) === r.agent);
  return [...rows.values()].sort((a, b) =>
    a.pm !== b.pm ? (a.pm ? -1 : 1) : a.pm ? pmIndex(a) - pmIndex(b) : first(a) - first(b) || a.agent.localeCompare(b.agent));
}

/** GET /ledger/:project/dag 的主体；调用方包读事务 */
export function dagBoard(db: Database, project: string, now: number): DagBoard {
  const ctx = boardContext(db, project, now);
  const features = hasFeatureSchema(db) ? listProjectFeatures(db, project).map((f) => featureCard(ctx, f)) : [];
  features.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1) || a.id.localeCompare(b.id));
  return { asOfSeq: ctx.asOfSeq, features, agents: progressRows(ctx, features) };
}
