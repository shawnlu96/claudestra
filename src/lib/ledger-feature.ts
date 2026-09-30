/**
 * feature 与子 DAG 版本的读侧（设计稿 docs/design/feature-dag.md）：行映射、id 解析、节点输入校验、只读投影。
 * 投影里节点的 status 每次从任务卡现读（stage），快照里记的 statusAtVersion 只是建版本那一刻的样子，两者不互相覆盖。
 * 写入在 ledger-feature-write.ts。
 */
import type { Database } from "bun:sqlite";
import type { DagCancel } from "./ledger-dag-rules.js";
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
type NodeStatus = Stage | typeof PLANNED;

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
  /** 这一版取消掉的进行中节点（v1 为空） */
  cancels: DagCancel[];
  scopeChange: boolean;
  /** 要 owner 批的重写：批准它的 ask；直接生效的为 null */
  askId: string | null;
}

/** 等 owner 批的重写（dag_proposals 一行）：批了才写成 dag_versions 的 version，期间当前版本不变 */
export interface DagProposal extends Omit<DagVersion, "approvedBy"> {
  seq: number;
  baseVersion: number;
  sha: string;
  askId: string;
  state: "pending" | "approved" | "rejected" | "void";
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

type Row = Record<string, unknown>;

const toFeature = (r: Row): Feature => r as unknown as Feature;

function toVersion(r: Row): DagVersion {
  return { ...(r as unknown as DagVersion), nodes: JSON.parse(String(r.nodes)) as DagNode[], cancels: JSON.parse(String(r.cancels ?? "[]")) as DagCancel[],
    scopeChange: r.scopeChange === 1, askId: (r.askId as string | null) ?? null };
}

const toProposal = (r: Row): DagProposal => ({ ...(r as unknown as DagProposal), ...toVersion(r) } as DagProposal);

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

export function getPendingProposal(db: Database, featureId: string): DagProposal | null {
  const r = db.prepare("SELECT * FROM dag_proposals WHERE featureId = ? AND state = 'pending'").get(featureId) as Row | null;
  return r ? toProposal(r) : null;
}

export function getProposal(db: Database, seq: number): DagProposal | null {
  const r = db.prepare("SELECT * FROM dag_proposals WHERE seq = ?").get(seq) as Row | null;
  return r ? toProposal(r) : null;
}

/** 版本快照并上 dag-bind 绑的卡：计划节点开工绑卡不产生新版本，读的时候合进来（快照本身只追加、不改） */
export function effectiveNodes(db: Database, v: Pick<DagVersion, "featureId" | "version" | "nodes">): DagNode[] {
  const rows = db.prepare("SELECT nodeKey, taskId FROM dag_bindings WHERE featureId = ? AND version = ?").all(v.featureId, v.version) as { nodeKey: string; taskId: string }[];
  const bound = new Map(rows.map((r) => [r.nodeKey, r.taskId]));
  return v.nodes.map((n) => (n.taskId || !bound.has(n.key) ? n : { ...n, taskId: bound.get(n.key) as string }));
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
