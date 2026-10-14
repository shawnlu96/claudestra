/**
 * 子 DAG「图」的聚焦图（纯函数，单测 tests/web-collab-dag-focus-layout.test.ts，team-project-SUBDAG7）：只画进行中节点和它们前后一跳，
 * 产出和 dag-layout.ts layoutDag 同形状，DagCanvasView 原样画。
 *   - 三列（空列不占位）：左 = 进行中的上游一跳（小节点），中 = 进行中（含 missing，完整卡），右 = 进行中的下游一跳（小节点）；
 *     既是上游又是下游的：已完成放左列，否则放右列。
 *   - 列内排序（重心法，扫一遍）：中列按 topoOrder；左列按它的进行中下游在中列的平均位置，右列按它的进行中上游的平均位置；平手按 key。
 *   - 两枚小片：左列顶上「✓ 其余 N 已完成」（N = counts.done − 左列画出的已完成），右列底下「更远 N」（N = 没画出来的未完成）；N = 0 不出。
 *     小片叠在列里不另占列：桌面中区只有六百来宽，横向能省就省。
 *     小片不收成员：线只画画出来的节点之间的 deps（edgesOf 复用，实线 / 点线口径同完整画布）。
 *   - 没有进行中节点 = null，由调用方退回完整画布。
 */
import type { Box } from "../v4/causal-model";
import type { BoardNode, FeatureCard } from "./dag-types";
import { COL_GAP, edgesOf, foldId, FULL_H, HEAD, kindOf, MIN_GROUP_W, MINI_H, nodeId, NODE_W, PAD, ROW_GAP, topoOrder,
  type DagCanvas, type DFold, type DGroup, type DNode } from "./dag-layout";

export const REST_W = 150;
export const FAR_W = 96;

/** 每个 key 在中列里相关节点的平均位置；平手按 key */
function byGravity(keys: readonly string[], links: (key: string) => number[]): string[] {
  const avg = new Map(keys.map((k) => {
    const xs = links(k);
    return [k, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity];
  }));
  return [...keys].sort((a, b) => avg.get(a)! - avg.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
}

/** 三列成员（中列已排好序） */
function focusColumns(f: FeatureCard): { left: string[]; mid: string[]; right: string[] } | null {
  const mid = topoOrder(f.nodes).filter((n) => n.phase === "active" || n.missing).map((n) => n.key);
  if (!f.nodes.some((n) => n.phase === "active")) return null;
  const inMid = new Set(mid);
  const byKey = new Map(f.nodes.map((n) => [n.key, n]));
  const up = new Set(mid.flatMap((k) => byKey.get(k)!.deps).filter((d) => byKey.has(d) && !inMid.has(d)));
  const down = new Set(f.nodes.filter((n) => !inMid.has(n.key) && n.deps.some((d) => inMid.has(d))).map((n) => n.key));
  const pos = new Map(mid.map((k, i) => [k, i]));
  const left = [...up].filter((k) => !down.has(k) || byKey.get(k)!.phase === "done");
  const right = [...down].filter((k) => !left.includes(k));
  const below = (k: string) => mid.filter((m) => byKey.get(m)!.deps.includes(k)).map((m) => pos.get(m)!);
  const above = (k: string) => byKey.get(k)!.deps.filter((d) => inMid.has(d)).map((d) => pos.get(d)!);
  return { left: byGravity(left, below), mid, right: byGravity(right, above) };
}

export function layoutFocus(f: FeatureCard): DagCanvas | null {
  const cols = focusColumns(f);
  if (!cols) return null;
  const byKey = new Map(f.nodes.map((n) => [n.key, n]));
  const restN = f.counts.done - cols.left.filter((k) => byKey.get(k)!.phase === "done").length;
  const farN = f.nodes.filter((n) => n.phase !== "done" && ![...cols.left, ...cols.mid, ...cols.right].includes(n.key)).length;
  // 一列 = 小片（可选，左列在顶、右列在底）+ 节点；空列不占位
  type Item = { fold: "rest" | "far"; n: number; w: number } | string;
  const lanes: Item[][] = [
    [...(restN > 0 ? [{ fold: "rest" as const, n: restN, w: REST_W }] : []), ...cols.left],
    cols.mid,
    [...cols.right, ...(farN > 0 ? [{ fold: "far" as const, n: farN, w: FAR_W }] : [])],
  ].filter((c) => c.length);
  const nodes: DNode[] = [];
  const folds: DFold[] = [];
  let tallest = 0;
  for (const [ci, lane] of lanes.entries()) {
    const x = PAD + ci * (NODE_W + COL_GAP);
    let y = HEAD;
    for (const it of lane) {
      if (typeof it !== "string") {
        folds.push({ id: `${foldId(f.id)}:${it.fold}`, featureId: f.id, members: [], n: it.n, open: false, kind: it.fold, x, y, w: it.w, h: MINI_H });
        y += MINI_H + ROW_GAP;
        continue;
      }
      const node: BoardNode = byKey.get(it)!;
      const kind = cols.mid.includes(it) ? kindOf(node) : "mini";
      const h = kind === "full" ? FULL_H : MINI_H;
      nodes.push({ id: nodeId(f.id, it), featureId: f.id, key: it, kind, node, mark: null, x, y, w: NODE_W, h });
      y += h + ROW_GAP;
    }
    tallest = Math.max(tallest, y - ROW_GAP - HEAD);
  }
  const w = Math.max(MIN_GROUP_W, PAD * 2 + lanes.length * NODE_W + (lanes.length - 1) * COL_GAP);
  const g: DGroup = { id: f.id, feature: f, nodes, folds, focus: true, x: 0, y: 0, w, h: HEAD + Math.max(tallest, MINI_H) + PAD };
  const boxOf = new Map(nodes.map((n) => [n.id, n.id]));
  const boxes = new Map<string, Box>([...nodes.map((n) => [n.id, n] as const), ...folds.map((x) => [x.id, x] as const)]);
  const all = new Map(f.nodes.map((n) => [nodeId(f.id, n.key), n]));
  return { groups: [g], edges: edgesOf([g], boxOf, boxes, all), w, h: g.h, boxOf };
}
