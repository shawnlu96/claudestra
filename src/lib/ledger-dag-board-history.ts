/**
 * 子 DAG 看板的按 feature 读（i28-L4）：版本列表 + 某一版快照，两版对比。和 ledger-dag-board.ts 同一套节点投影；
 * 历史版也按卡现读状态，快照当时的样子在 statusAtVersion（同 dagSnapshot；missing 节点为 null）。调用方包读事务；找不到版本抛 LedgerError not_found。
 */
import type { Database } from "bun:sqlite";
import { dagDiff, dagSnapshot } from "./ledger-dag-view.js";
import { diffNodes, nodePhase, type DagDiff, type NodePhase } from "./ledger-dag-rules.js";
import { effectiveNodes, getDagVersion, getPendingProposal, type DagNode, type Feature } from "./ledger-feature.js";
import { stageTimeline } from "./ledger-metrics.js";
import { LedgerError } from "./ledger-store.js";
import { boardContext, boardNodes, featureCard, ownTask, pendingMeta, phaseNow, versionMeta, type BoardCtx, type BoardNode, type FeatureCard, type VersionMeta } from "./ledger-dag-board.js";

interface VersionEntry extends VersionMeta {
  /** 相对上一版；v1 为 null */
  delta: { added: number; removed: number; changed: number; cancelled: number } | null;
}

export interface FeatureDetail {
  feature: Omit<FeatureCard, "nodes">;
  versions: VersionEntry[];
  snapshot: { version: number | "pending"; meta: VersionMeta; nodes: BoardNode[] } | null;
}

/** ?version= 的取值：缺省 = 当前版；数字；pending */
export type VersionSel = number | "pending" | undefined;

function versionList(db: Database, f: Feature): VersionEntry[] {
  const nums = (db.query("SELECT version FROM dag_versions WHERE featureId = ? ORDER BY version").all(f.id) as { version: number }[]).map((r) => r.version);
  return nums.map((n, i) => {
    const v = getDagVersion(db, f.id, n) as NonNullable<ReturnType<typeof getDagVersion>>;
    const prev = i > 0 ? nums[i - 1] : null;
    const d = prev === null ? null : dagDiff(db, f, String(prev), String(n)).diff;
    return { ...versionMeta(v), delta: d && { added: d.added.length, removed: d.removed.length, changed: d.carried.filter((c) => c.changed).length, cancelled: d.cancelled.length } };
  });
}

export function featureDetail(db: Database, f: Feature, sel: VersionSel, now: number): FeatureDetail {
  const ctx = boardContext(db, f.project, now);
  const { nodes: _nodes, ...feature } = featureCard(ctx, f);
  let snapshot: FeatureDetail["snapshot"] = null;
  if (sel === "pending") {
    const p = f.currentVersion ? dagSnapshot(db, f).pending : null;
    if (!p) throw new LedgerError("not_found", `feature ${f.id} 没有待批的重写`);
    snapshot = { version: "pending", meta: pendingMeta(p), nodes: boardNodes(ctx, p.nodes) };
  } else if (sel !== undefined || f.currentVersion) {
    const s = dagSnapshot(db, f, sel);
    snapshot = { version: s.version.version, meta: versionMeta(s.version), nodes: boardNodes(ctx, s.version.nodes) };
  }
  return { feature, versions: versionList(db, f), snapshot };
}

export interface FeatureDiff {
  from: number;
  to: number;
  diff: DagDiff;
  phaseNow: Record<string, NodePhase>;
  rewrittenDone: string[];
}

/** 某一版（或 pending）的节点、它生效 / 提出的时刻，以及它的上一版（pending = 它基于的那一版） */
function versionAt(db: Database, f: Feature, sel: number | "pending"): { nodes: DagNode[]; createdAt: number; version: number; prev: number } {
  if (sel === "pending") {
    const p = getPendingProposal(db, f.id);
    if (!p) throw new LedgerError("not_found", `feature ${f.id} 没有待批的重写`);
    return { nodes: p.nodes, createdAt: p.createdAt, version: p.version, prev: p.baseVersion };
  }
  const v = sel >= 1 ? getDagVersion(db, f.id, sel) : null;
  if (!v) throw new LedgerError("not_found", `feature ${f.id} 没有 v${sel}`);
  return { nodes: effectiveNodes(db, v), createdAt: v.createdAt, version: v.version, prev: v.version - 1 };
}

/** 节点在 ts 那一刻是否已完成：卡的阶段时间线或快照记的 status 任一说已完成就算；别的项目的卡 / 找不到的卡一律不算（快照里它的阶段也不出） */
function doneAt(ctx: BoardCtx, n: DagNode, ts: number): boolean {
  if (!n.taskId) return false;
  const task = ownTask(ctx, n.taskId);
  if (!task) return false;
  const stage = stageTimeline(ctx.events.get(task.id) ?? [], ctx.now).findLast((s) => s.from <= ts)?.stage;
  return (!!stage && nodePhase(n.taskId, stage) === "done") || (n.status !== "planned" && nodePhase(n.taskId, n.status) === "done");
}

/**
 * from → to 之间逐次重写核对：某一次改了 key、而那次重写生效 / 提出时它已完成，才算。
 * 只看两端会错：完成前合法改过、之后又原样带入的节点，拿 to 的时刻判会误报，拿 from 的时刻判又漏掉 from 之后才完成的。
 */
function rewrittenDoneKeys(db: Database, f: Feature, ctx: BoardCtx, from: VersionNodes, to: VersionNodes, keys: readonly string[]): string[] {
  const chain = [from];
  for (let v = from.version + 1; v <= to.prev; v++) chain.push(versionAt(db, f, v));
  chain.push(to);
  const hit = new Set<string>();
  for (let i = 1; i < chain.length; i++) {
    const a = new Map(chain[i - 1].nodes.map((n) => [n.key, n]));
    const { carried } = diffNodes(chain[i - 1].nodes, chain[i].nodes, []);
    for (const c of carried) if (c.changed && keys.includes(c.key) && doneAt(ctx, a.get(c.key) as DagNode, chain[i].createdAt)) hit.add(c.key);
  }
  return keys.filter((k) => hit.has(k));
}

type VersionNodes = ReturnType<typeof versionAt>;

/** to 缺省 = 当前版，from 缺省 = to − 1；pending 只能在 to；from ≥ to 抛 invalid */
export function featureDiff(db: Database, f: Feature, rawFrom: number | undefined, rawTo: number | "pending" | undefined, now: number): FeatureDiff {
  if (rawTo === undefined && !f.currentVersion) throw new LedgerError("not_found", `feature ${f.id} 还没建 DAG`);
  const to = versionAt(db, f, rawTo ?? f.currentVersion);
  const fromN = rawFrom ?? to.version - 1;
  if (fromN >= to.version) throw new LedgerError("invalid", `from（v${fromN}）要早于 to（v${to.version}）`);
  const from = versionAt(db, f, fromN);
  const { diff } = dagDiff(db, f, String(from.version), rawTo === "pending" ? "pending" : String(to.version));
  const ctx = boardContext(db, f.project, now);
  const toByKey = new Map(to.nodes.map((n) => [n.key, n]));
  const phase: Record<string, NodePhase> = {};
  for (const n of [...from.nodes, ...to.nodes]) phase[n.key] = phaseNow(ctx, (toByKey.get(n.key) ?? n).taskId);
  // 正常重写里已完成的节点只能原样带入（planRewrite），出现在这里 = 库被手改过或是 L2 之前的历史
  const rewrittenDone = rewrittenDoneKeys(db, f, ctx, from, to, diff.carried.filter((c) => c.changed).map((c) => c.key));
  return { from: from.version, to: to.version, diff, phaseNow: phase, rewrittenDone };
}
