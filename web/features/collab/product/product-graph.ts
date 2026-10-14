/**
 * 项目地图的图（纯函数，单测 tests/web-project-map-layout.test.ts）：每个 feature 的状态与分区、要画的边、层号、连通分量、列内顺序。
 * 只看 board，不看视口；同一输入逐字同一输出（遍历只按 board 里的顺序和 id 比较）。
 */
import { knownFeatureState, type ProductBoard, type ProductDep, type ProductFeature, type ProductLink } from '../../../lib/api/product-board-types';

/** feature-split 写进 feature_deps 的固定 note（同 src/lib/ledger-product-board-edges.ts:15 的 SPLIT_NOTE）；旧后端没有 kind 时按它认 split */
export const SPLIT_NOTE = 'feature-split 默认前置';

export type MapState = 'done' | 'run' | 'blocked' | 'stale' | 'ready' | 'gate' | 'wait' | 'paused' | 'frozen';
/** 主区排序：小的在前。paused / frozen / done 不进主区 */
export const PRIO: Readonly<Record<string, number>> = { blocked: 0, run: 1, stale: 2, ready: 3, gate: 4, wait: 5 };
const prio = (s: MapState) => PRIO[s] ?? 9;

/** status=paused 一律 paused；认得的 state 照用；否则按计数回退（团队视图、旧后端） */
export function featureState(f: ProductFeature): MapState {
  if (f.status === 'paused') return 'paused';
  const known = knownFeatureState(f.state);
  if (known) return known;
  const c = f.counts;
  if (f.status === 'done') return 'done';
  if ((c.blocked ?? 0) > 0) return 'blocked';
  if (c.active > 0 && !c.activeUnknown) return 'run';
  if (c.total > 0 && c.completed === c.total) return 'done';
  return 'wait';
}

export type MapZone = 'main' | 'done' | 'paused' | 'hidden';
export function zoneOf(f: ProductFeature, state = featureState(f)): MapZone {
  if (f.status === 'dropped') return 'hidden';
  if (state === 'done') return 'done';
  return state === 'paused' || state === 'frozen' ? 'paused' : 'main';
}

export type EdgeSource = 'declared' | 'task' | 'lock';
export interface GraphEdge {
  id: string; from: string; to: string;
  /** 结构边列出来源（declared / task，可两种都有）；锁边只有 lock */
  kinds: EdgeSource[];
  satisfied: boolean;
  /** 任务依赖的条数（锁边是争用处数）；只有手写依赖时是 1 */
  count: number;
  /** 加进来会成环：只叠画，不参与分层 */
  back: boolean;
  /** 原始数据，给边页用 */
  deps: ProductDep[];
  links: ProductLink[];
}
export interface GraphNode {
  id: string; feature: ProductFeature; state: MapState;
  /** 链上的完成小标签：前置在「已收尾」里、后继在主区 */
  chip: boolean;
  rank: number;
  /** 拆自哪个 feature（来源标题） */
  splitFrom: string | null;
}
export interface ProductGraph {
  /** 主区节点 + 链上的完成小标签 */
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** 节点数 ≥ 2 的连通分量，按优先级排；每串里按层号分列，列内已排好 */
  chains: GraphNode[][][];
  /** 只有 1 个节点的，按优先级排 */
  solo: GraphNode[];
  done: ProductFeature[];
  paused: ProductFeature[];
}

const isSplit = (d: ProductDep) => d.kind === 'split' || (d.kind === undefined && d.note === SPLIT_NOTE);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 列内 / 区内比较：PRIO、在跑数（多的在前）、最近活动（新的在前）、id */
export function nodeOrder(a: GraphNode, b: GraphNode): number {
  return prio(a.state) - prio(b.state) || b.feature.counts.active - a.feature.counts.active
    || (b.feature.lastActivityAt ?? -1) - (a.feature.lastActivityAt ?? -1) || cmp(a.id, b.id);
}

/** 同一对 (from, to) 的手写依赖与任务依赖合成一条结构边；锁边单独成一条。旧后端的手写依赖没有 satisfied：前置收尾了就算成立 */
function mergeEdges(board: ProductBoard, keep: (from: string, to: string, structural: boolean) => boolean, doneFrom: (id: string) => boolean): GraphEdge[] {
  const out = new Map<string, GraphEdge>();
  const add = (from: string, to: string, src: EdgeSource, satisfied: boolean, count: number, dep?: ProductDep, link?: ProductLink) => {
    if (from === to || !keep(from, to, src !== 'lock')) return;
    const id = `${src === 'lock' ? 'lock' : 'dep'}:${from}>${to}`;
    const e = out.get(id) ?? { id, from, to, kinds: [], satisfied: true, count: 0, back: false, deps: [], links: [] };
    if (!e.kinds.includes(src)) e.kinds.push(src);
    e.satisfied &&= satisfied;
    if (dep) e.deps.push(dep);
    if (link) { e.links.push(link); e.count += count; }
    out.set(id, e);
  };
  for (const d of board.deps) if (!isSplit(d)) add(d.from, d.to, 'declared', d.satisfied ?? doneFrom(d.from), 0, d);
  for (const l of board.links ?? []) if (l.kind === 'task') add(l.from, l.to, 'task', l.satisfied, l.count, undefined, l);
  for (const l of board.links ?? []) if (l.kind === 'lock') add(l.from, l.to, 'lock', l.satisfied, l.count, undefined, l);
  return [...out.values()].map(e => (e.count ? e : { ...e, count: 1 }));
}

/** 结构边先、锁边后逐条加；会成环的标 back。层号取最长路径，只有出边的源点靠到后继最小层号 − 1 */
function rank(ids: readonly string[], edges: GraphEdge[]): Map<string, number> {
  const out = new Map(ids.map(id => [id, [] as string[]]));
  const reaches = (from: string, to: string) => {
    const seen = new Set([from]), stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      for (const n of out.get(id) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    return false;
  };
  for (const e of edges) {
    if (reaches(e.to, e.from)) e.back = true;
    else out.get(e.from)!.push(e.to);
  }
  const indeg = new Map(ids.map(id => [id, 0]));
  for (const id of ids) for (const n of out.get(id)!) indeg.set(n, indeg.get(n)! + 1);
  const ranks = new Map(ids.map(id => [id, 0]));
  const queue = ids.filter(id => !indeg.get(id));
  for (let i = 0; i < queue.length; i++) {
    for (const n of out.get(queue[i])!) {
      ranks.set(n, Math.max(ranks.get(n)!, ranks.get(queue[i])! + 1));
      indeg.set(n, indeg.get(n)! - 1);
      if (!indeg.get(n)) queue.push(n);
    }
  }
  const hasIn = new Set(ids.flatMap(id => out.get(id)!));
  for (const id of ids) {
    const next = out.get(id)!;
    if (!hasIn.has(id) && next.length) ranks.set(id, Math.min(...next.map(n => ranks.get(n)!)) - 1);
  }
  return ranks;
}

/** 连通分量（back 边也算连通），按 ids 的顺序给出 */
function components(ids: readonly string[], edges: readonly GraphEdge[]): string[][] {
  const root = new Map(ids.map(id => [id, id]));
  const find = (id: string): string => {
    let r = id;
    while (root.get(r) !== r) r = root.get(r)!;
    return r;
  };
  for (const e of edges) {
    const a = find(e.from), b = find(e.to);
    if (a !== b) root.set(b, a);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()];
}

/** 一串链按层号分列，列内先按 nodeOrder，再跑两轮重心法：先看前驱的平均位置，再看后继的 */
function columnsOf(nodes: GraphNode[], edges: readonly GraphEdge[]): GraphNode[][] {
  const min = Math.min(...nodes.map(n => n.rank));
  const cols: GraphNode[][] = [];
  for (const n of [...nodes].sort(nodeOrder)) (cols[n.rank - min] ??= []).push(n);
  const filled = Array.from(cols, c => c ?? []);
  const pos = () => new Map(filled.flatMap(c => c.map((n, i) => [n.id, i] as const)));
  const pass = (near: (id: string) => string[], order: number[]) => {
    for (const c of order) {
      const at = pos();
      const key = new Map(filled[c].map((n, i) => {
        const ns = near(n.id).filter(id => at.has(id));
        return [n.id, ns.length ? ns.reduce((s, id) => s + at.get(id)!, 0) / ns.length : i] as const;
      }));
      filled[c] = filled[c].map((n, i) => ({ n, i })).sort((a, b) => key.get(a.n.id)! - key.get(b.n.id)! || a.i - b.i).map(x => x.n);
    }
  };
  const live = edges.filter(e => !e.back);
  const idx = filled.map((_, i) => i);
  pass(id => live.filter(e => e.to === id).map(e => e.from), idx.slice(1));
  pass(id => live.filter(e => e.from === id).map(e => e.to), idx.slice(0, -1).reverse());
  return filled;
}

export function productGraph(board: ProductBoard): ProductGraph {
  const features = board.features.filter(f => f.status !== 'dropped');
  const byId = new Map(features.map(f => [f.id, f]));
  const states = new Map(features.map(f => [f.id, featureState(f)]));
  const zone = (id: string) => { const f = byId.get(id); return f ? zoneOf(f, states.get(id)) : 'hidden'; };
  const splitFrom = new Map<string, string>();
  for (const d of board.deps) if (isSplit(d) && byId.has(d.from) && !splitFrom.has(d.to)) splitFrom.set(d.to, byId.get(d.from)!.title || d.from);
  const edges = mergeEdges(board, (from, to, structural) =>
    zone(to) === 'main' && (zone(from) === 'main' || (structural && zone(from) === 'done')), id => states.get(id) === 'done');
  const chipIds = new Set(edges.filter(e => zone(e.from) === 'done').map(e => e.from));
  const ids = features.filter(f => zone(f.id) === 'main' || chipIds.has(f.id)).map(f => f.id);
  const ranks = rank(ids, edges);
  const nodes = new Map(ids.map(id => [id, { id, feature: byId.get(id)!, state: states.get(id)!, chip: chipIds.has(id),
    rank: ranks.get(id)!, splitFrom: splitFrom.get(id) ?? null } satisfies GraphNode]));
  const comps = components(ids, edges).map(c => c.map(id => nodes.get(id)!));
  const best = (c: GraphNode[]) => c.filter(n => !n.chip).sort(nodeOrder)[0];
  const chains = comps.filter(c => c.length > 1).sort((a, b) => nodeOrder(best(a), best(b))).map(c => columnsOf(c, edges));
  const solo = comps.filter(c => c.length === 1).map(c => c[0]).sort(nodeOrder);
  return { nodes, edges, chains, solo, done: features.filter(f => zone(f.id) === 'done'), paused: features.filter(f => zone(f.id) === 'paused') };
}
