/**
 * 项目地图的聚焦、过滤与关键路径（纯函数，单测 tests/web-project-map-focus.test.ts）。只读 productLayout 的结果和 board，不看视口。
 * - focusSet：沿结构边（含 back）取全部祖先和后代；锁边只取直接相连的一层（Nx project graph 的 --focus）。
 * - criticalPath：主区里不是 gate 的 feature，只沿没满足、不是 back 的结构边走，权重 eta.basis.cpHours，求最长路径（原型 CP）。
 * - highlight：选中 / 过滤 / 关键路径叠在一起时，哪些卡和边变暗、哪些边加粗、哪些卡描边。
 */
import type { ProductBoard } from '../../../lib/api/product-board-types';
import type { MapState } from './product-graph';
import type { MapSummary, ProductCanvas, ProductEdgeView } from './product-layout';

export type ProductPick = { kind: 'feature' | 'edge'; id: string };
type Layout = Pick<ProductCanvas, 'nodes' | 'chips' | 'edges'>;
const isLock = (e: ProductEdgeView) => e.kinds.includes('lock');

export interface FocusSet { nodes: Set<string>; edges: Set<string> }

/** 选中卡的上下游：结论里含它自己 */
export function focusSet(layout: Pick<ProductCanvas, 'edges'>, id: string): FocusSet {
  const nodes = new Set([id]), edges = new Set<string>();
  const structural = layout.edges.filter(e => !isLock(e));
  const walk = (near: (e: ProductEdgeView) => string, far: (e: ProductEdgeView) => string) => {
    const seen = new Set([id]), stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of structural) {
        if (near(e) !== cur) continue;
        edges.add(e.id);
        nodes.add(far(e));
        if (!seen.has(far(e))) { seen.add(far(e)); stack.push(far(e)); }
      }
    }
  };
  walk(e => e.to, e => e.from);
  walk(e => e.from, e => e.to);
  for (const e of layout.edges) {
    if (!isLock(e) || (e.from !== id && e.to !== id)) continue;
    edges.add(e.id);
    nodes.add(e.from === id ? e.to : e.from);
  }
  return { nodes, edges };
}

export interface CriticalPath { ids: string[]; edges: string[]; hours: number }
export const NO_PATH: CriticalPath = { ids: [], edges: [], hours: 0 };

/** 没有任何 cpHours，或者连不起 2 个节点：返回空路径（开关禁用）。同长时取 layout 里靠前的 */
export function criticalPath(board: ProductBoard, layout: Pick<ProductCanvas, 'nodes' | 'edges'>): CriticalPath {
  const hoursOf = new Map(board.features.map(f => [f.id, f.eta?.basis?.cpHours ?? 0]));
  const ids = layout.nodes.filter(n => !n.chip && n.state !== 'gate').map(n => n.id);
  const inMain = new Set(ids);
  const live = layout.edges.filter(e => !isLock(e) && !e.back && !e.satisfied && inMain.has(e.from) && inMain.has(e.to));
  const best = new Map<string, { h: number; next: ProductEdgeView | null }>();
  const visiting = new Set<string>();
  const longest = (id: string): number => {
    const hit = best.get(id);
    if (hit) return hit.h;
    visiting.add(id);
    let tail = 0, next: ProductEdgeView | null = null;
    for (const e of live) {
      if (e.from !== id || visiting.has(e.to)) continue;
      const h = longest(e.to);
      if (next === null || h > tail) { tail = h; next = e; }
    }
    visiting.delete(id);
    const h = (hoursOf.get(id) ?? 0) + tail;
    best.set(id, { h, next });
    return h;
  };
  // 起点只取有出边的：单独一个权重大的节点连不成路径
  let start: string | null = null, top = 0;
  for (const id of ids) if (live.some(e => e.from === id) && longest(id) > top) { top = longest(id); start = id; }
  if (start === null) return NO_PATH;
  const out: CriticalPath = { ids: [start], edges: [], hours: top };
  for (let e = best.get(start)!.next; e; e = best.get(e.to)!.next) { out.edges.push(e.id); out.ids.push(e.to); }
  return out.ids.length > 1 ? out : NO_PATH;
}

export type MapFilter = 'all' | 'run' | 'blocked' | 'ready' | 'gate' | 'wait';
/** 过滤胶囊的顺序和归类：「受阻 · 久未动」= blocked 或 stale */
export const FILTERS: readonly { key: MapFilter; states: readonly MapState[] }[] = [
  { key: 'all', states: [] }, { key: 'run', states: ['run'] }, { key: 'blocked', states: ['blocked', 'stale'] },
  { key: 'ready', states: ['ready'] }, { key: 'gate', states: ['gate'] }, { key: 'wait', states: ['wait'] },
];
export const isFilter = (v: unknown): v is MapFilter => FILTERS.some(f => f.key === v);

/** 只数主区（摘要已经只数主区） */
export function filterCount(summary: MapSummary, key: MapFilter): number {
  return key === 'all' ? summary.total : FILTERS.find(f => f.key === key)!.states.reduce((n, s) => n + (summary[s as keyof MapSummary] ?? 0), 0);
}

export function filterMatch(key: MapFilter, state: MapState): boolean {
  return key === 'all' || FILTERS.find(f => f.key === key)!.states.includes(state);
}

export interface Highlight { selected: Set<string>; dim: Set<string>; strong: Set<string>; dimEdges: Set<string> }

/**
 * 三样叠加：选中的上下游 ∩ 过滤匹配 ∩ 关键路径以外的都变暗；选中的卡自己不变暗。选中边只给两端描边，不变暗。
 * 过滤匹配数为 0 时按「全部」算（存下来的过滤值可能已经没有卡了）。
 */
export function highlight(layout: Layout, o: { pick: ProductPick | null; filter: MapFilter; summary: MapSummary; cp: CriticalPath | null }): Highlight {
  const out: Highlight = { selected: new Set(), dim: new Set(), strong: new Set(), dimEdges: new Set() };
  const edgePick = o.pick?.kind === 'edge' ? layout.edges.find(e => e.id === o.pick!.id) : undefined;
  if (edgePick) { out.selected.add(edgePick.from); out.selected.add(edgePick.to); }
  const picked = o.pick?.kind === 'feature' && layout.nodes.some(n => n.id === o.pick!.id) ? o.pick.id : null;
  const focus = picked === null ? null : focusSet(layout, picked);
  if (picked !== null) out.selected.add(picked);
  const filter = filterCount(o.summary, o.filter) > 0 ? o.filter : 'all';
  const cp = o.cp && o.cp.ids.length ? { ids: new Set(o.cp.ids), edges: new Set(o.cp.edges) } : null;
  const lit = (id: string, state: MapState | null) => id === picked || ((!focus || focus.nodes.has(id))
    && (filter === 'all' || (state !== null && filterMatch(filter, state))) && (!cp || cp.ids.has(id)));
  for (const n of layout.nodes) if (!lit(n.id, n.chip ? null : n.state)) out.dim.add(n.id);
  for (const c of layout.chips) if (!lit(c.id, null)) out.dim.add(c.id);
  for (const e of layout.edges) {
    if (out.dim.has(e.from) || out.dim.has(e.to) || (focus && !focus.edges.has(e.id)) || (cp && !cp.edges.has(e.id))) out.dimEdges.add(e.id);
    else if (focus?.edges.has(e.id) || cp?.edges.has(e.id)) out.strong.add(e.id);
  }
  return out;
}

/** 关键路径的时长：取整；超过 48 小时按天写 */
export function cpSpan(hours: number): { word: 'h' | 'd'; n: number } {
  return hours > 48 ? { word: 'd', n: Math.round(hours / 24) } : { word: 'h', n: Math.round(hours) };
}
