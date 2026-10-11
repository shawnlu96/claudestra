/**
 * 子 DAG 的只读视图（dag-show 与 MCP 工具 show_dag / plan_feature 共用，manager/ledger-dag-cmds.ts 与 bridge/dag-tools.ts 各调一次）：
 * 某一版的快照（并上绑卡、状态现读）与两版之间的差异。只读库，不写；找不到版本抛 not_found，调用方原样回给用户。
 */
import type { Database } from "bun:sqlite";
import { diffNodes, type DagCancel, type DagDiff } from "./ledger-dag-rules.js";
import { effectiveNodes, getDagVersion, getPendingProposal, projectNodes, type DagNode, type DagProposal, type DagVersion, type Feature, type NodeView } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import { isSourceAcceptedNode, pageAcceptedBySource } from "./ui-page-display.js";

/** 版本号或 pending → 节点（已并上绑卡）与这一版记下的取消 */
function versionNodes(db: Database, f: Feature, raw: string): { nodes: DagNode[]; cancels: DagCancel[]; version: number } {
  if (raw === "pending") {
    const p = getPendingProposal(db, f.id);
    if (!p) throw new LedgerError("not_found", `feature ${f.id} 没有待批的重写`);
    return { nodes: p.nodes, cancels: p.cancels, version: p.version };
  }
  if (!/^\d+$/.test(raw)) throw new LedgerError("invalid", `--diff 的版本要是数字或 pending，收到 ${raw}`);
  const v = getDagVersion(db, f.id, Number(raw));
  if (!v) throw new LedgerError("not_found", `feature ${f.id} 没有 v${raw}`);
  return { nodes: effectiveNodes(db, v), cancels: v.cancels, version: v.version };
}

/** a → b 的差异；取消原因取 (a, b] 之间各版（含 pending）记下的 */
export function dagDiff(db: Database, f: Feature, a: string, b: string): { from: number; to: number; diff: DagDiff } {
  const from = versionNodes(db, f, a);
  const to = versionNodes(db, f, b);
  const between: DagCancel[] = [];
  for (let v = from.version + 1; v <= to.version; v++) {
    between.push(...(v === to.version ? to.cancels : (getDagVersion(db, f.id, v)?.cancels ?? [])));
  }
  return { from: from.version, to: to.version, diff: diffNodes(from.nodes, to.nodes, between) };
}

export interface DagSnapshot {
  version: Omit<DagVersion, "nodes"> & { nodes: NodeView[] };
  pending: (Omit<DagProposal, "nodes"> & { nodes: NodeView[] }) | null;
}

/** 某一版的快照（缺省当前版），附任务卡现读的状态；同时给出 pending 提案。凭项目验收源 done 的当前版 PAGEOK 叠成已满足（status 仍 planned） */
export function dagSnapshot(db: Database, f: Feature, version?: number): DagSnapshot {
  const n = version ?? f.currentVersion;
  const v = n ? getDagVersion(db, f.id, n) : null;
  if (!v) throw new LedgerError("not_found", f.currentVersion ? `feature ${f.id} 没有 v${n}（当前 v${f.currentVersion}）` : `feature ${f.id} 还没建 DAG（先 dag-init）`);
  const p = getPendingProposal(db, f.id);
  let nodes = projectNodes(db, effectiveNodes(db, v));
  if (pageAcceptedBySource(db, f, v.version)) {
    nodes = nodes.map((x) => (isSourceAcceptedNode(x) ? { ...x, satisfied: true, ready: false, acceptedBy: "project_source" as const } : x));
  }
  return { version: { ...v, nodes }, pending: p ? { ...p, nodes: projectNodes(db, p.nodes) } : null };
}
