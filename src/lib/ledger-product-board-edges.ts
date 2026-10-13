/**
 * 产品板的依赖边（设计稿 C-project-dag §2.3 / §4.5）：只读投影，不落库。
 * deps = feature_deps 原样加 kind / satisfied（split | declared），顺序不变；旧网页只读 from / to / note。
 * links = 派生边：跨 feature 的卡依赖（task）与文件锁争用（lock）。不进 deps：ETA 与旧网页布局都按 deps 走，卡依赖会成环。
 */
import type { Database } from "bun:sqlite";
import { depViews } from "./ledger-deps.js";
import type { DagNode } from "./ledger-feature.js";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { LedgerTask, Stage } from "./ledger-stages.js";
import { listDeps } from "./ledger-store.js";
import { deferredLine } from "./product-node-counts.js";

/** feature-split 写进 feature_deps 的固定 note（ledger-feature-split-plan.ts planDeps）；FDKIND1 加 kind 列后改认字段 */
export const SPLIT_NOTE = "feature-split 默认前置";
/** 一条 lock 边最多带这么多条证据；count 照实 */
export const LOCK_EVIDENCE_MAX = 20;
/** 后继卡已经走完：这条卡依赖不再挡人 */
const DOWNSTREAM_DONE: readonly Stage[] = ["verified", "done", "cancelled"];
const CLOSED_FEATURE = ["done", "dropped"];

type EdgeKind = "split" | "declared" | "task" | "lock";
interface TaskEvidence { from: string; to: string; fromStage: Stage; toStage: Stage; satisfied: boolean }
interface LockEvidence { node: string; wanted: string; held: string; holder: string; since: number }
export interface ProductEdge {
  from: string;
  to: string;
  note: string;
  kind: EdgeKind;
  satisfied: boolean;
  count: number;
  evidence: (TaskEvidence | LockEvidence)[];
}
export interface ProductEdgesInput {
  project: string;
  deps: readonly { from: string; to: string; note: string }[];
  /** complete 由 PDSTATE1 加；没有时只看 status */
  features: readonly { id: string; status: string; complete?: boolean }[];
  tasks: readonly LedgerTask[];
  entries: readonly { f: { id: string; status: string }; nodes: readonly (DagNode & { task: LedgerTask | null })[] }[];
}
interface Held { resource: string; taskId: string; acquiredAt: number }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 文件锁：不带「:」的路径，或 repo: 私仓锁；merge: 合并槽等其余命名资源只是容量 */
const isFileLock = (r: string): boolean => !r.includes(":") || r.startsWith("repo:");

function featureEdges(input: ProductEdgesInput): ProductEdge[] {
  const byId = new Map(input.features.map((f) => [f.id, f]));
  return input.deps.map(({ from, to, note }) => {
    const pre = byId.get(from);
    return { from, to, note, kind: note === SPLIT_NOTE ? "split" : "declared",
      satisfied: pre?.status === "done" || pre?.complete === true, count: 1, evidence: [] };
  });
}

function taskEdges(db: Database, input: ProductEdgesInput): ProductEdge[] {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const groups = new Map<string, ProductEdge & { evidence: TaskEvidence[] }>();
  for (const v of depViews(listDeps(db, input.project), input.tasks)) {
    const a = byId.get(v.from), b = byId.get(v.to);
    if (!a?.featureId || !b?.featureId || a.featureId === b.featureId) continue;
    const satisfied = v.effective === "done" || DOWNSTREAM_DONE.includes(b.stage);
    const key = `${a.featureId}\n${b.featureId}`;
    const edge = groups.get(key) ?? { from: a.featureId, to: b.featureId, note: "", kind: "task", satisfied: true, count: 0, evidence: [] };
    edge.evidence.push({ from: a.id, to: b.id, fromStage: a.stage, toStage: b.stage, satisfied });
    edge.count++; edge.satisfied &&= satisfied;
    groups.set(key, edge);
  }
  return [...groups.values()];
}

function heldLocks(db: Database, project: string): Held[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_resources'").get()) return [];
  return db.query("SELECT resource, taskId, acquiredAt FROM scheduler_resources WHERE project = ? ORDER BY resource, taskId").all(project) as Held[];
}

/** 还没开工的非远期节点：没绑卡，或绑的卡还在 spec */
const notStarted = (n: DagNode & { task: LedgerTask | null }): boolean =>
  !deferredLine(n.oneLine) && (!n.taskId || n.task?.stage === "spec");

function lockEdges(db: Database, input: ProductEdgesInput): ProductEdge[] {
  const cardFeature = new Map<string, string>();
  for (const e of input.entries) for (const n of e.nodes) if (n.taskId) cardFeature.set(n.taskId, e.f.id);
  for (const t of input.tasks) if (t.featureId) cardFeature.set(t.id, t.featureId);
  const held = heldLocks(db, input.project).flatMap((h) => {
    const key = isFileLock(h.resource) ? resourceKey(h.resource) : null, feature = cardFeature.get(h.taskId);
    return key && feature ? [{ ...h, key, feature }] : [];
  });
  if (!held.length) return [];
  const groups = new Map<string, { from: string; to: string; nodes: Set<string>; evidence: LockEvidence[] }>();
  for (const e of input.entries) {
    if (CLOSED_FEATURE.includes(e.f.status)) continue;
    for (const n of e.nodes.filter(notStarted)) {
      const wanted = (n.fileGlobs ?? []).flatMap((g) => resourceKey(g) ?? []);
      for (const h of held) {
        if (h.feature === e.f.id) continue;
        const hit = wanted.find((w) => resourcesOverlap(w, h.key));
        if (hit === undefined) continue;
        const key = `${h.feature}\n${e.f.id}`;
        const g = groups.get(key) ?? { from: h.feature, to: e.f.id, nodes: new Set<string>(), evidence: [] };
        g.nodes.add(n.key);
        g.evidence.push({ node: n.key, wanted: hit, held: h.resource, holder: h.taskId, since: h.acquiredAt });
        groups.set(key, g);
      }
    }
  }
  return [...groups.values()].map((g) => ({ from: g.from, to: g.to, note: "", kind: "lock" as const, satisfied: false, count: g.nodes.size,
    evidence: g.evidence.sort((a, b) => cmp(a.node, b.node) || cmp(a.held, b.held) || cmp(a.holder, b.holder)).slice(0, LOCK_EVIDENCE_MAX) }));
}

/** 两条查询（task_deps、scheduler_resources）各一次，不按 feature 循环。同样输入、输出逐字相同 */
export function productEdges(db: Database, input: ProductEdgesInput): { deps: ProductEdge[]; links: ProductEdge[] } {
  const links = [...taskEdges(db, input), ...lockEdges(db, input)]
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind));
  return { deps: featureEdges(input), links };
}
