/**
 * 子 DAG 图的布局（纯函数，单测 tests/web-collab-dag-layout.test.ts）。输入是 L4 快照（dag-types.ts），画法定在 i28-V1 规格：
 *   - 每个 feature 一个分组框；默认最多展开 MAX_OPEN 个（active 且有进行中节点，按最近动静降序），其余收进上方一条；
 *   - 框里按依赖的最长路径从左往右分列；进行中 / missing 是完整节点，没开始的是小节点；
 *   - done 节点收成框左上角的「✓N」（N = counts.done），点开才展开；连向它们的线收到「✓N」上；
 *   - 线只画节点的 deps：前置已满足实线，否则点线。对比模式下 from 版独有的节点画成幽灵（dag-diff.ts 给数据）。
 *   - 点开 ✓N 后可以分页（SUBDAG7）：给了页数 p 的 feature，每列已完成最多显示 p × DONE_PAGE 个，其余收进这一列底部的「还有 N」。
 * 产出的形状满足 v4/canvas-view.ts 的 ViewCanvas，视口、居中、「适配全部」照用。
 */
import type { Box } from "../v4/causal-model";
import type { BoardNode, FeatureCard, NodePhase } from "./dag-types";
import type { DiffMark } from "./dag-diff";

export const MAX_OPEN = 8;
export const NODE_W = 220;
export const COL_GAP = 72;
export const FULL_H = 82;
export const MINI_H = 34;
export const FOLD_W = 64;
export const ROW_GAP = 10, PAD = 14, HEAD = 40, MIN_GROUP_W = 360;
const GROUP_GAP = 28;
/** 完整画布每列每页的已完成数 */
export const DONE_PAGE = 12;
export const MORE_W = 150;

export type DNodeKind = "full" | "mini" | "ghost";
export interface DNode extends Box { id: string; featureId: string; key: string; kind: DNodeKind; node: BoardNode; mark: DiffMark | null }
/** kind：rest = 聚焦图「其余 N 已完成」，far = 聚焦图「更远 N」，more = 完整画布列底「还有 N」；不带 = 框角 ✓N */
export type FoldKind = "rest" | "far" | "more";
export interface DFold extends Box { id: string; featureId: string; members: string[]; n: number; open: boolean; kind?: FoldKind }
/** focus：聚焦图（dag-focus-layout.ts）的框，框头不出「✓N 收起」 */
export interface DGroup extends Box { id: string; feature: FeatureCard; nodes: DNode[]; folds: DFold[]; focus?: true }
export interface DEdge { id: string; from: string; to: string; solid: boolean; x1: number; y1: number; x2: number; y2: number }
export interface DagCanvas {
  groups: DGroup[];
  edges: DEdge[];
  w: number;
  h: number;
  /** 节点 id → 它画在哪个框里（自己，或收着它的「✓N」） */
  boxOf: Map<string, string>;
}

/** 对比模式叠在某个 feature 上：to 版的节点、from 版独有的幽灵节点、每个 key 的差异标记 */
export interface Overlay { featureId: string; nodes: BoardNode[]; ghosts: BoardNode[]; marks: ReadonlyMap<string, DiffMark> }

export const nodeId = (featureId: string, key: string) => `${featureId}::${key}`;
export const foldId = (featureId: string) => `${featureId}::✓`;

/** 有图的 feature（currentVersion > 0），保持接口给的顺序 */
export const drawable = (features: readonly FeatureCard[]) => features.filter((f) => f.currentVersion > 0);

const recency = (f: FeatureCard) => f.lastActivityAt ?? -Infinity;

/** 默认展开：active 且有进行中节点的，按 lastActivityAt 降序取前 MAX_OPEN 个 */
export function defaultOpen(features: readonly FeatureCard[]): string[] {
  return drawable(features).filter((f) => f.status === "active" && f.counts.active > 0)
    .sort((a, b) => recency(b) - recency(a)).slice(0, MAX_OPEN).map((f) => f.id);
}

/** 再展开一个：超过 MAX_OPEN 就把别的里面最久没动静的那个收起来（evicted） */
export function openWith(open: readonly string[], id: string, features: readonly FeatureCard[]): { open: string[]; evicted: string | null } {
  if (open.includes(id)) return { open: [...open], evicted: null };
  const next = [...open, id];
  if (next.length <= MAX_OPEN) return { open: next, evicted: null };
  const byId = new Map(features.map((f) => [f.id, f]));
  const others = open.filter((x) => x !== id);
  const age = (x: string) => (byId.get(x) ? recency(byId.get(x)!) : -Infinity);
  const victim = others.reduce((a, b) => (age(b) < age(a) ? b : a));
  return { open: next.filter((x) => x !== victim), evicted: victim };
}

/** 列号 = 沿 deps 的最长路径（只算给定节点之间的边）；有环就在环上停 */
export function longestPath(nodes: readonly Pick<BoardNode, "key" | "deps">[]): Map<string, number> {
  const deps = new Map(nodes.map((n) => [n.key, n.deps]));
  const memo = new Map<string, number>();
  const visit = (key: string, seen: Set<string>): number => {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (seen.has(key)) return 0;
    seen.add(key);
    const r = Math.max(-1, ...(deps.get(key) ?? []).filter((d) => deps.has(d)).map((d) => visit(d, seen))) + 1;
    seen.delete(key);
    memo.set(key, r);
    return r;
  };
  for (const n of nodes) visit(n.key, new Set());
  return memo;
}

const PHASE_ORDER: Record<NodePhase, number> = { active: 0, idle: 1, done: 2 };

/** 拓扑序（列号，再进行中 → 没开始 → 已完成，再快照里的顺序）；手机分节与框内排行共用 */
export function topoOrder(nodes: readonly BoardNode[]): BoardNode[] {
  const rank = longestPath(nodes);
  const idx = new Map(nodes.map((n, i) => [n.key, i]));
  return [...nodes].sort((a, b) => rank.get(a.key)! - rank.get(b.key)! || PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || idx.get(a.key)! - idx.get(b.key)!);
}

/** 每列的已完成节点（topoOrder 序，即框里自上而下的顺序），列号同 longestPath */
function doneByCol(nodes: readonly BoardNode[]): Map<number, BoardNode[]> {
  const rank = longestPath(nodes);
  const out = new Map<number, BoardNode[]>();
  for (const n of topoOrder(nodes)) {
    if (n.phase !== "done") continue;
    const c = rank.get(n.key)!;
    out.set(c, [...(out.get(c) ?? []), n]);
  }
  return out;
}

/** 完整画布分页时能看到这个节点的最小页数；不是已完成（或找不到）= 1 */
export function donePageOf(f: FeatureCard, key: string): number {
  for (const list of doneByCol(f.nodes).values()) {
    const i = list.findIndex((n) => n.key === key);
    if (i >= 0) return Math.floor(i / DONE_PAGE) + 1;
  }
  return 1;
}

export const kindOf = (n: BoardNode): DNodeKind => (n.phase === "active" || n.missing ? "full" : "mini");

interface Slot { key: string; node: BoardNode; ghost: boolean }

/** 分页时每列超出 page × DONE_PAGE 的已完成节点：列号 → slot */
function pagedOut(all: readonly Slot[], page: number | undefined): Map<number, Slot[]> {
  const out = new Map<number, Slot[]>();
  if (page === undefined || page < 1) return out;
  const slot = new Map(all.map((s) => [s.node, s]));
  for (const [c, list] of doneByCol(all.map((s) => s.node))) if (list.length > page * DONE_PAGE) out.set(c, list.slice(page * DONE_PAGE).map((n) => slot.get(n)!));
  return out;
}

function placeGroup(f: FeatureCard, top: number, doneOpen: boolean, ov: Overlay | null, page?: number): DGroup {
  const nodes = ov ? ov.nodes : f.nodes;
  const all: Slot[] = [...nodes.map((n) => ({ key: n.key, node: n, ghost: false })), ...(ov?.ghosts ?? []).map((n) => ({ key: n.key, node: n, ghost: true }))];
  const showDone = doneOpen || ov !== null; // 对比时已完成节点也要看得到（带入有改、rewrittenDone 都标在它们身上）
  const hidden = showDone ? [] : all.filter((s) => !s.ghost && s.node.phase === "done");
  const paged = pagedOut(all, showDone && !ov ? page : undefined);
  const more = new Set([...paged.values()].flat());
  const shown = all.filter((s) => !hidden.includes(s) && !more.has(s));
  const rank = longestPath(all.map((s) => s.node));
  const cols = [...new Set(shown.map((s) => rank.get(s.key)!))].sort((a, b) => a - b);
  const doneCount = ov ? 0 : f.counts.done;
  const fold = !showDone && (hidden.length > 0 || doneCount > 0);
  const x0 = PAD + (fold ? FOLD_W + COL_GAP / 2 : 0);
  const y0 = top + HEAD;
  const out: DNode[] = [];
  const folds: DFold[] = [];
  let tallest = fold ? MINI_H : 0;
  for (const [ci, c] of cols.entries()) {
    let y = y0;
    for (const s of topoOrder(shown.filter((x) => rank.get(x.key) === c).map((x) => x.node))) {
      const ghost = shown.find((x) => x.node === s)!.ghost;
      const kind: DNodeKind = ghost ? "ghost" : kindOf(s);
      const h = kind === "full" ? FULL_H : MINI_H;
      out.push({ id: nodeId(f.id, s.key), featureId: f.id, key: s.key, kind, node: s, mark: ov?.marks.get(s.key) ?? null, x: x0 + ci * (NODE_W + COL_GAP), y, w: NODE_W, h });
      y += h + ROW_GAP;
    }
    const rest = paged.get(c);
    if (rest) {
      folds.push({ id: `${foldId(f.id)}:${c}`, featureId: f.id, members: rest.map((s) => nodeId(f.id, s.key)), n: rest.length, open: false, kind: "more",
        x: x0 + ci * (NODE_W + COL_GAP), y, w: MORE_W, h: MINI_H });
      y += MINI_H + ROW_GAP;
    }
    tallest = Math.max(tallest, y - ROW_GAP - y0);
  }
  if (fold) folds.unshift({ id: foldId(f.id), featureId: f.id, members: hidden.map((s) => nodeId(f.id, s.key)), n: doneCount, open: false, x: PAD, y: y0, w: FOLD_W, h: MINI_H });
  const inner = cols.length ? x0 + cols.length * NODE_W + (cols.length - 1) * COL_GAP + PAD : x0 + PAD;
  return { id: f.id, feature: f, nodes: out, folds, x: 0, y: top, w: Math.max(MIN_GROUP_W, inner), h: HEAD + Math.max(tallest, MINI_H) + PAD };
}

/** 线：节点的 deps，两端按 boxOf 落到节点或「✓N」上；同一对框只画一根，前置全满足才是实线。幽灵节点不连线（聚焦图 dag-focus-layout.ts 复用） */
export function edgesOf(groups: readonly DGroup[], boxOf: ReadonlyMap<string, string>, boxes: ReadonlyMap<string, Box>, nodes: ReadonlyMap<string, BoardNode>): DEdge[] {
  const pairs = new Map<string, boolean>();
  for (const g of groups) {
    const ghosts = new Set(g.nodes.filter((n) => n.kind === "ghost").map((n) => n.key));
    const folds = new Set(g.folds.map((f) => f.id));
    const keys = [...g.nodes.filter((n) => n.kind !== "ghost").map((n) => n.key), ...g.folds.flatMap((f) => f.members.map((m) => m.slice(g.id.length + 2)))];
    for (const key of keys) {
      const to = boxOf.get(nodeId(g.id, key));
      for (const d of nodes.get(nodeId(g.id, key))?.deps ?? []) {
        const from = boxOf.get(nodeId(g.id, d));
        // 指向「✓N」/ 列底「还有 N」的线只会是往回连（已完成节点依赖没完成的，多半是改写 / 取消留下的）：收起时不画，点开 ✓N 后照常画
        if (!from || !to || from === to || ghosts.has(d) || folds.has(to)) continue;
        const id = `${from}>${to}`;
        pairs.set(id, (pairs.get(id) ?? true) && nodes.get(nodeId(g.id, d))!.satisfied);
      }
    }
  }
  return [...pairs].map(([id, solid]) => {
    const [a, b] = id.split(">") as [string, string];
    const p = boxes.get(a)!, q = boxes.get(b)!;
    return { id, from: a, to: b, solid, x1: p.x + p.w, y1: p.y + p.h / 2, x2: q.x, y2: q.y + q.h / 2 };
  });
}

/** open = 展开的 feature id（按接口顺序画）；doneOpen = 点开了「✓N」的 feature；overlay = 正在对比的那一个；donePages = 已完成分页的页数（没有 = 一次全画） */
export function layoutDag(features: readonly FeatureCard[], open: readonly string[], doneOpen: ReadonlySet<string>, overlay: Overlay | null = null,
  donePages?: ReadonlyMap<string, number>): DagCanvas {
  const groups: DGroup[] = [];
  let top = 0;
  for (const f of drawable(features).filter((x) => open.includes(x.id))) {
    const g = placeGroup(f, top, doneOpen.has(f.id), overlay?.featureId === f.id ? overlay : null, donePages?.get(f.id));
    groups.push(g);
    top += g.h + GROUP_GAP;
  }
  const boxOf = new Map<string, string>();
  const boxes = new Map<string, Box>();
  const nodes = new Map<string, BoardNode>();
  for (const g of groups) {
    const ov = overlay?.featureId === g.id ? overlay : null;
    for (const n of [...(ov ? ov.nodes : g.feature.nodes), ...(ov?.ghosts ?? [])]) if (!nodes.has(nodeId(g.id, n.key))) nodes.set(nodeId(g.id, n.key), n);
    for (const n of g.nodes) {
      boxOf.set(n.id, n.id);
      boxes.set(n.id, n);
    }
    for (const f of g.folds) {
      boxes.set(f.id, f);
      for (const m of f.members) boxOf.set(m, f.id);
    }
  }
  return { groups, edges: edgesOf(groups, boxOf, boxes, nodes), w: Math.max(0, ...groups.map((g) => g.w)), h: Math.max(0, top - GROUP_GAP), boxOf };
}
