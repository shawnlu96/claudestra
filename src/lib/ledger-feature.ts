/**
 * feature 与子 DAG 版本的读侧（设计稿 docs/design/feature-dag.md）：行映射、id 解析、节点输入校验、只读投影。
 * 投影里节点的 status 每次从任务卡现读（stage），快照里记的 statusAtVersion 只是建版本那一刻的样子，两者不互相覆盖。
 * 写入在 ledger-feature-write.ts。
 */
import type { Database } from "bun:sqlite";
import type { DagReasonKind, FeatureStatus } from "./ledger-feature-schema.js";
import { isSatisfied } from "./ledger-deps.js";
import { TERMINAL_STAGES, type LedgerTask, type Stage } from "./ledger-stages.js";
import { getTask, LedgerError } from "./ledger-store.js";

export interface Feature {
  id: string;
  project: string;
  title: string;
  ownerWords: string;
  status: FeatureStatus;
  /** 0 = 还没建 DAG */
  currentVersion: number;
  rev: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** 没有任务卡的节点（计划中，开工时再绑卡，绑卡属于 L2）的状态 */
export const PLANNED = "planned";
export type NodeStatus = Stage | typeof PLANNED;

/** 版本快照里的一个节点；key 在同一版里唯一，taskId 可空（还没建卡） */
export interface DagNode {
  key: string;
  taskId: string | null;
  oneLine: string;
  /** 依赖的节点 key */
  deps: string[];
  /** 建版本时任务卡的 stage；没卡为 planned */
  status: NodeStatus;
  /** 粗估（「半天」「S」这类自由短文本），没估为 "" */
  estimate: string;
  /** 从哪一版原样继承来的；新加 / 改过的节点为 null */
  inheritedFrom: number | null;
}

export interface DagVersion {
  featureId: string;
  version: number;
  reasonKind: DagReasonKind;
  reasonText: string;
  proposedBy: string;
  approvedBy: string | null;
  createdAt: number;
  nodes: DagNode[];
}

type Row = Record<string, unknown>;

export const toFeature = (r: Row): Feature => r as unknown as Feature;

function toVersion(r: Row): DagVersion {
  return { ...(r as unknown as DagVersion), nodes: JSON.parse(String(r.nodes)) as DagNode[] };
}

export function getFeature(db: Database, id: string): Feature | null {
  const r = db.prepare("SELECT * FROM features WHERE id = ?").get(id) as Row | null;
  return r ? toFeature(r) : null;
}

/** 命令行里写全 id（带前缀）或只写 slug 都认：先按全 id 找，再按「本机前缀-slug」找 */
export function resolveFeature(db: Database, raw: string | undefined, origin: string | null): Feature {
  if (!raw) throw new LedgerError("invalid", "缺 feature id");
  const f = getFeature(db, raw) ?? (origin ? getFeature(db, `${origin}-${raw}`) : null);
  if (!f) throw new LedgerError("not_found", `没有 feature ${raw}`);
  return f;
}

export function getDagVersion(db: Database, featureId: string, version: number): DagVersion | null {
  const r = db.prepare("SELECT * FROM dag_versions WHERE featureId = ? AND version = ?").get(featureId, version) as Row | null;
  return r ? toVersion(r) : null;
}

export function listFeatures(db: Database, project: string): Feature[] {
  return (db.prepare("SELECT * FROM features WHERE project = ? ORDER BY id").all(project) as Row[]).map(toFeature);
}

/** 投影出来的节点：快照字段 + 任务卡现读的 status / title */
export interface NodeView extends Omit<DagNode, "status"> {
  /** 有卡 = 卡的当前 stage；没卡 = planned；卡找不到 = null */
  status: NodeStatus | null;
  statusAtVersion: NodeStatus;
  title: string | null;
  /** 按依赖边的口径算「满足」（ledger-deps.ts isSatisfied：code 上线即算，ops / investigate 要 done） */
  satisfied: boolean;
  /** 依赖节点全部满足、自己还没满足也没终态：可以开工 */
  ready: boolean;
  /** 绑了卡却找不到（被迁走 / 手改库）：status 为 null，不猜 */
  missing: boolean;
}

export function projectNodes(db: Database, nodes: readonly DagNode[]): NodeView[] {
  const live = new Map<string, LedgerTask | null>(nodes.map((n) => [n.key, n.taskId ? getTask(db, n.taskId) : null]));
  const ok = (key: string) => {
    const t = live.get(key);
    return !!t && isSatisfied(t);
  };
  return nodes.map(({ status, ...n }) => {
    const t = live.get(n.key) ?? null;
    const missing = !!n.taskId && !t;
    const open = n.taskId ? !!t && !ok(n.key) && !TERMINAL_STAGES.includes(t.stage) : true;
    return {
      ...n, status: n.taskId ? (t?.stage ?? null) : PLANNED, statusAtVersion: status, title: t?.title ?? null,
      satisfied: ok(n.key), ready: open && n.deps.every(ok), missing,
    };
  });
}
