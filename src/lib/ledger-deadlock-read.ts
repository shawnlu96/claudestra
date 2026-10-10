/**
 * 等待图的取数（规则在 ledger-deadlock.ts）：一个只读事务里读本项目的卡、task_deps、各 feature 当前版子 DAG、调度 workflow 与文件锁。
 * 只 SELECT，不迁移、不建表：老库缺表 = 没有这类事实（与 schedulerProjectView 同口径）；表在但读坏了进 unknown，不当无环。
 * 只取图要的字段（id / 阶段 / fileGlobs / 资源名 / intent），不带标题、备注、凭据或进程信息。
 */
import type { Database } from "bun:sqlite";
import { waitGraph, type WaitCard, type WaitFacts, type WaitFeature, type WaitGraph, type WaitHeld } from "./ledger-deadlock.js";
import type { WorkflowMode } from "./ledger-scheduler.js";
import { listDeps, listTasks } from "./ledger-store.js";

const hasTable = (db: Database, table: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

type Unknown = (why: string) => void;

function workflows(db: Database, project: string): Map<string, { mode: WorkflowMode; rev: number }> {
  if (!hasTable(db, "task_workflows")) return new Map();
  const rows = db.query("SELECT taskId, mode, rev FROM task_workflows WHERE project = ?").all(project) as { taskId: string; mode: WorkflowMode; rev: number }[];
  return new Map(rows.map((r) => [r.taskId, { mode: r.mode, rev: r.rev }]));
}

function dagNodes(raw: unknown, feature: string, version: number, unknown: Unknown): WaitFeature["nodes"] | null {
  let nodes: unknown;
  try {
    nodes = JSON.parse(String(raw));
  } catch (e) {
    unknown(`${feature} v${version} 节点 JSON 读不了：${(e as Error).message.slice(0, 80)}`); // 写进 unknown：这个 feature 的边判不了，不当没边
    return null;
  }
  const ok = Array.isArray(nodes) && nodes.every((n) => n && typeof n.key === "string" && Array.isArray(n.deps) &&
    n.deps.every((d: unknown) => typeof d === "string") && (n.taskId === null || n.taskId === undefined || typeof n.taskId === "string"));
  if (!ok) { unknown(`${feature} v${version} 节点结构不认识`); return null; }
  return (nodes as { key: string; taskId?: string | null; deps: string[] }[]).map((n) => ({ key: n.key, taskId: n.taskId ?? null, deps: n.deps }));
}

/** 只看还在推进的 feature（active / paused）的当前版；绑卡记录（dag_bindings）合进没写 taskId 的节点 */
function features(db: Database, project: string, unknown: Unknown): WaitFeature[] {
  if (!hasTable(db, "features") || !hasTable(db, "dag_versions")) return [];
  const rows = db.query(`SELECT f.id, f.currentVersion AS version, v.nodes, v.createdAt FROM features f
    LEFT JOIN dag_versions v ON v.featureId = f.id AND v.version = f.currentVersion
    WHERE f.project = ? AND f.status IN ('active','paused') AND f.currentVersion > 0 ORDER BY f.id`).all(project) as
    { id: string; version: number; nodes: string | null; createdAt: number | null }[];
  const binds = hasTable(db, "dag_bindings");
  const out: WaitFeature[] = [];
  for (const r of rows) {
    if (r.nodes === null) { unknown(`${r.id} 当前版 v${r.version} 不在 dag_versions`); continue; }
    const nodes = dagNodes(r.nodes, r.id, r.version, unknown);
    if (!nodes) continue;
    const bound = new Map(binds ? (db.query("SELECT nodeKey, taskId FROM dag_bindings WHERE featureId = ? AND version = ?").all(r.id, r.version) as
      { nodeKey: string; taskId: string }[]).map((b) => [b.nodeKey, b.taskId]) : []);
    out.push({ id: r.id, version: r.version, createdAt: r.createdAt ?? 0, nodes: nodes.map((n) => (n.taskId ? n : { ...n, taskId: bound.get(n.key) ?? null })) });
  }
  return out;
}

function held(db: Database, project: string): WaitHeld[] {
  if (!hasTable(db, "scheduler_resources")) return [];
  return db.query("SELECT resource, taskId, intentId, acquiredAt, scope FROM scheduler_resources WHERE project = ? ORDER BY resource, taskId")
    .all(project) as WaitHeld[];
}

/** 每段单独兜错：一段坏了只让那一段进 unknown，其余事实照样进图（已看到的环照报） */
function facts(db: Database, project: string): WaitFacts {
  const unknown: string[] = [];
  const add: Unknown = (why) => void unknown.push(why);
  const part = <T>(name: string, fallback: T, read: () => T): T => {
    try {
      return read();
    } catch (e) {
      add(`${name} 读不了：${(e as Error).message.slice(0, 120)}`); // 进 unknown：本轮等待规则不进 evaluated，旧发现不被误关
      return fallback;
    }
  };
  const wf = part("task_workflows", new Map<string, { mode: WorkflowMode; rev: number }>(), () => workflows(db, project));
  const tasks: WaitCard[] = part("tasks", [], () => listTasks(db, project)).map((t) => ({
    id: t.id, kind: t.kind, stage: t.stage, stageBefore: t.stageBefore, extra: { fileGlobs: t.extra.fileGlobs }, workflow: wf.get(t.id) ?? null,
  }));
  return {
    project,
    asOfSeq: part("events", 0, () => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq),
    tasks,
    deps: part("task_deps", [], () => listDeps(db, project)),
    features: part("features", [], () => features(db, project, add)),
    held: part("scheduler_resources", [], () => held(db, project)),
    unknown,
  };
}

/** 一个项目的等待图：一个 deferred 读事务（query_only 连接也能跑），所有事实同一快照 */
export function readWaitGraph(db: Database, project: string): WaitGraph {
  return waitGraph(db.transaction(() => facts(db, project)).deferred());
}

/** 通知基线与等待图同一读快照；缺失/未知时先不推首轮积压，不能冒充已有基线。 */
export function readWaitAuditSnapshot(db: Database, project: string): { waitGraph: WaitGraph; waitBaseline: string[] | null } {
  return db.transaction(() => {
    const graph = waitGraph(facts(db, project));
    let baseline: string[] | null = null;
    try {
      baseline = hasTable(db, "audit_baseline")
        ? (db.query("SELECT rule FROM audit_baseline WHERE project = ? AND rule IN ('wait_cycle', 'wait_missing_node')")
          .all(project) as { rule: string }[]).map((r) => r.rule) : [];
    } catch (e) {
      console.warn(`等待通知基线读不了，未完整扫描的规则暂停通知：${(e as Error).message}`);
    }
    return { waitGraph: graph, waitBaseline: baseline };
  }).deferred();
}
