/**
 * 版本对比叠在图上的那一层（纯函数，单测 tests/web-collab-dag-diff.test.ts）。分类原样跟 L4 的 diff（src/lib/ledger-dag-rules.ts diffNodes）：
 * 增 = to 版新出现；删 = 移出去的没开始节点；带入且有改 = 两版都有但内容变了；取消 = 移出去的进行中节点（带原因；key 还在、换了卡的
 * 那一条同时算「带入有改」）。rewrittenDone 是已完成节点被改写过，一律标 error 色。from 版独有的节点（删、取消且已不在）画成幽灵。
 */
import type { BoardNode, DagCancelView, DagDiffResponse } from "./dag-types";
import type { Overlay } from "./dag-layout";

export interface DiffMark {
  added?: true;
  /** from 版独有：用 from 版快照画一个虚线幽灵 */
  ghost?: true;
  changed?: true;
  /** 取消原因 */
  cancelled?: string;
  rewrittenDone?: true;
}

export interface Compare {
  featureId: string;
  from: number;
  /** 数字或「pending」（只能当 to） */
  to: number | "pending";
}

/** 默认对比：当前版 vs 上一版；只有 v1 时没有可比的（null）。有待批的重写时也可以选当前版 → pending */
export function defaultCompare(featureId: string, currentVersion: number): Compare | null {
  return currentVersion > 1 ? { featureId, from: currentVersion - 1, to: currentVersion } : null;
}

/** 两个版本号选成一次对比：小的当 from；pending 只能当 to */
export function compareOf(featureId: string, a: number | "pending", b: number | "pending"): Compare | null {
  if (a === b) return null;
  if (a === "pending") return typeof b === "number" ? { featureId, from: b, to: "pending" } : null;
  if (b === "pending") return { featureId, from: a, to: "pending" };
  return { featureId, from: Math.min(a, b), to: Math.max(a, b) };
}

export function diffMarks(d: Pick<DagDiffResponse, "diff" | "rewrittenDone">, toKeys: ReadonlySet<string>): Map<string, DiffMark> {
  const out = new Map<string, DiffMark>();
  const put = (k: string, m: DiffMark) => out.set(k, { ...out.get(k), ...m });
  for (const k of d.diff.added) put(k, { added: true });
  for (const k of d.diff.removed) put(k, { ghost: true });
  for (const c of d.diff.carried) if (c.changed) put(c.key, { changed: true });
  for (const c of d.diff.cancelled) put(c.key, { cancelled: c.reason || "", ...(toKeys.has(c.key) ? {} : { ghost: true as const }) });
  for (const k of d.rewrittenDone) put(k, { rewrittenDone: true });
  return out;
}

/** 叠图：to 版节点照画，from 版独有的进幽灵（位置照样按最长路径排，见 dag-layout.ts） */
export function compareOverlay(featureId: string, toNodes: readonly BoardNode[], fromNodes: readonly BoardNode[], d: Pick<DagDiffResponse, "diff" | "rewrittenDone">): Overlay {
  const toKeys = new Set(toNodes.map((n) => n.key));
  return { featureId, nodes: [...toNodes], ghosts: fromNodes.filter((n) => !toKeys.has(n.key)), marks: diffMarks(d, toKeys) };
}

export interface DiffItem { key: string; oneLine: string; reason?: string }
export interface DiffLists { added: DiffItem[]; removed: DiffItem[]; changed: DiffItem[]; cancelled: DiffItem[]; rewrittenDone: DiffItem[] }

/** 属性区差异页、手机底部抽屉用的四类清单（另带 rewrittenDone）；一句话取所在那一版的快照 */
export function diffLists(d: Pick<DagDiffResponse, "diff" | "rewrittenDone">, fromNodes: readonly BoardNode[], toNodes: readonly BoardNode[]): DiffLists {
  const line = (k: string) => toNodes.find((n) => n.key === k)?.oneLine ?? fromNodes.find((n) => n.key === k)?.oneLine ?? "";
  const item = (k: string): DiffItem => ({ key: k, oneLine: line(k) });
  return {
    added: d.diff.added.map(item),
    removed: d.diff.removed.map(item),
    changed: d.diff.carried.filter((c) => c.changed).map((c) => item(c.key)),
    cancelled: d.diff.cancelled.map((c: DagCancelView) => ({ ...item(c.key), reason: c.reason })),
    rewrittenDone: d.rewrittenDone.map(item),
  };
}
