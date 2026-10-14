/**
 * 项目地图的摆放（纯函数，单测 tests/web-project-map-layout.test.ts）。图在 product-graph.ts，这里只把它摆到画布上：
 * - 按依赖（默认）：依赖链区在左，一串一带、按优先级从上往下；独立推进区在右，网格每行 2 或 3 个；
 * - 按板块：每个板块一条泳道，链上节点按全局层号定列，下面是本泳道的独立推进；没有板块的进最后一条「未分组」；
 * - 「已暂停」「已收尾」展开时，小标签排在画布最底部，按板块分行（已暂停在上）。
 * 和视口宽高无关；卡高由 cardHeight 逐张给（PDCARD1 会改它），行高取一行里最高的卡。
 */
import type { ProductArea, ProductBoard, ProductFeature } from '../../../lib/api/product-board-types';
import type { ViewCanvas } from '../v4/canvas-view';
import { CARD_W, CHIP_H, CHIP_W, cardHeight as defaultHeight } from './product-card-model';
import { PRIO, productGraph, type GraphEdge, type GraphNode, type MapState } from './product-graph';

interface Box { x: number; y: number; w: number; h: number }
export type MapMode = 'dep' | 'lane';
export interface LayoutOpts {
  mode?: MapMode;
  doneOpen?: boolean;
  pausedOpen?: boolean;
  /** 按板块时，展开了已收尾小标签的泳道（板块 id，未分组是 ''） */
  laneDone?: readonly string[];
  cardHeight?: (f: ProductFeature) => number;
}
export interface ProductNode extends Box {
  id: string; kind: 'full' | 'idle'; feature: ProductFeature; state: MapState; chip: boolean; splitFrom: string | null; rank: number;
}
/** 底部 / 泳道里的小标签：已收尾、已暂停、冻结 */
export interface ProductChip extends Box { id: string; kind: 'idle'; feature: ProductFeature; tag: 'done' | 'paused' | 'frozen' }
export interface ProductEdgeView extends GraphEdge {
  x1: number; y1: number; x2: number; y2: number;
  /** back 边从两端底部绕下去，弧线最低处的控制点 */
  loopY: number | null;
  solid: boolean;
  note: string;
}
export interface ZoneWord { w: string; n?: number }
/** 区头、泳道框、底部分行的标签。label 是数据里的名字（板块名），words 是要过词表的词 */
export interface ProductZone extends Box {
  id: string; kind: 'chains' | 'solo' | 'lane' | 'shelf' | 'row';
  label: string | null;
  words: ZoneWord[];
  /** 泳道头的「✓ M」 */
  lane?: { key: string; done: number; open: boolean };
}
export type MapSummary = Record<'total' | 'run' | 'blocked' | 'stale' | 'ready' | 'gate' | 'wait', number>;
export interface ProductCanvas extends ViewCanvas {
  mode: MapMode;
  /** board 带 areas 才能按板块 */
  lanesOk: boolean;
  nodes: ProductNode[];
  chips: ProductChip[];
  edges: ProductEdgeView[];
  zones: ProductZone[];
  done: ProductFeature[];
  paused: ProductFeature[];
  summary: MapSummary;
}

const PAD = 16, HEAD = 26, HEAD_GAP = 10, COL_GAP = 140, ROW_GAP = 14, CHAIN_GAP = 28, BACK_ROOM = 48, SOLO_GAP = 110, GRID_GAP = 24;
const SHELF_GAP = 36, CHIP_GAP = 10, ROW_LABEL = 136, LANE_PAD = 14, LANE_GAP = 16;
const COL = CARD_W + COL_GAP;

type Height = (f: ProductFeature) => number;
interface Placed { nodes: ProductNode[]; bottom: Map<string, number> }

function toNode(n: GraphNode, x: number, y: number, h: number): ProductNode {
  return { id: n.id, kind: n.state === 'run' ? 'full' : 'idle', feature: n.feature, state: n.state, chip: n.chip, splitFrom: n.splitFrom,
    rank: n.rank, x: n.chip ? x + CARD_W - CHIP_W : x, y, w: n.chip ? CHIP_W : CARD_W, h };
}

/** 一串链：列 x 由 colX 给，每列在带内竖向居中；带 back 边的带子下面多留 BACK_ROOM。返回带高 */
function placeChain(cols: GraphNode[][], top: number, colX: (n: GraphNode, c: number) => number, height: Height, back: boolean, out: Placed) {
  const hOf = (n: GraphNode) => (n.chip ? CHIP_H : height(n.feature));
  const colH = cols.map(c => c.reduce((s, n) => s + hOf(n), 0) + Math.max(0, c.length - 1) * ROW_GAP);
  const band = Math.max(0, ...colH);
  const placed: ProductNode[] = [];
  cols.forEach((c, i) => {
    let y = top + (band - colH[i]) / 2;
    for (const n of c) {
      placed.push(toNode(n, colX(n, i), y, hOf(n)));
      y += hOf(n) + ROW_GAP;
    }
  });
  const total = band + (back ? BACK_ROOM : 0);
  for (const n of placed) { out.nodes.push(n); out.bottom.set(n.id, top + band); }
  return total;
}

/** 独立推进网格：每行 count > 6 ? 3 : 2 个，行高取这一行最高的卡。返回占用的高度 */
function placeGrid(solo: GraphNode[], x0: number, top: number, height: Height, out: Placed): { w: number; h: number } {
  const per = solo.length > 6 ? 3 : 2;
  let y = top;
  for (let i = 0; i < solo.length; i += per) {
    const row = solo.slice(i, i + per);
    const h = Math.max(...row.map(n => height(n.feature)));
    row.forEach((n, j) => { const p = toNode(n, x0 + j * (CARD_W + GRID_GAP), y, height(n.feature)); out.nodes.push(p); out.bottom.set(n.id, y + h); });
    y += h + ROW_GAP;
  }
  return { w: solo.length ? Math.min(per, solo.length) * (CARD_W + GRID_GAP) - GRID_GAP : 0, h: solo.length ? y - top - ROW_GAP : 0 };
}

const hasBack = (ids: ReadonlySet<string>, edges: readonly GraphEdge[]) => edges.some(e => e.back && ids.has(e.from) && ids.has(e.to));
const head = (id: string, kind: ProductZone['kind'], x: number, y: number, w: number, words: ZoneWord[], label: string | null = null): ProductZone =>
  ({ id, kind, x, y, w, h: HEAD, words, label });

function layoutDep(g: ReturnType<typeof productGraph>, height: Height, out: Placed, zones: ProductZone[]): number {
  let y = PAD + HEAD + HEAD_GAP, right = PAD;
  for (const cols of g.chains) {
    const ids = new Set(cols.flat().map(n => n.id));
    y += placeChain(cols, y, (_, c) => PAD + c * COL, height, hasBack(ids, g.edges), out) + CHAIN_GAP;
    right = Math.max(right, PAD + cols.length * COL - COL_GAP);
  }
  if (g.chains.length) zones.push(head('zone:chains', 'chains', PAD, PAD, right - PAD, [{ w: '依赖链 · {n} 串', n: g.chains.length }]));
  const x0 = g.chains.length ? right + SOLO_GAP : PAD;
  const grid = placeGrid(g.solo, x0, PAD + HEAD + HEAD_GAP, height, out);
  if (g.solo.length) {
    zones.push(head('zone:solo', 'solo', x0, PAD, grid.w, [{ w: '独立推进 · {n} 个', n: g.solo.length },
      { w: '{n} 在跑', n: g.solo.filter(n => n.state === 'run').length }]));
  }
  const bottoms = out.nodes.map(n => n.y + n.h);
  return Math.max(y - CHAIN_GAP, PAD + HEAD + HEAD_GAP + grid.h, ...bottoms);
}

const areaKey = (f: ProductFeature, areas: ReadonlySet<string>) => (f.area && areas.has(f.area) ? f.area : '');

/** 一行小标签：有板块名就先写名字 */
function chipRow(fs: ProductFeature[], prefix: string, tag: (f: ProductFeature) => ProductChip['tag'], x0: number, y: number, out: ProductChip[]) {
  fs.forEach((f, i) => out.push({ id: `${prefix}:${f.id}`, kind: 'idle', feature: f, tag: tag(f), x: x0 + i * (CHIP_W + CHIP_GAP), y, w: CHIP_W, h: CHIP_H }));
}

/** 底部一组小标签：按板块分行，没有板块的放「未分组」；board 没有 areas 时一行排完 */
function placeShelf(kind: 'done' | 'paused', fs: ProductFeature[], areas: readonly ProductArea[] | undefined, top: number, chips: ProductChip[], zones: ProductZone[]) {
  const tag = (f: ProductFeature): ProductChip['tag'] => (kind === 'done' ? 'done' : f.status !== 'paused' && f.state === 'frozen' ? 'frozen' : 'paused');
  zones.push(head(`shelf:${kind}`, 'shelf', PAD, top, ROW_LABEL, [{ w: kind === 'done' ? '已收尾' : '已暂停' }]));
  let y = top + HEAD + HEAD_GAP;
  if (!areas) {
    chipRow(fs, kind, tag, PAD, y, chips);
    return y + CHIP_H;
  }
  const keys = new Set(areas.map(a => a.id));
  for (const a of [...areas, { id: '', name: '' }]) {
    const row = fs.filter(f => areaKey(f, keys) === a.id);
    if (!row.length) continue;
    zones.push({ ...head(`row:${kind}:${a.id}`, 'row', PAD, y, ROW_LABEL - 8, a.id ? [] : [{ w: '未分组' }], a.id ? a.name : null), h: CHIP_H });
    chipRow(row, kind, tag, PAD + ROW_LABEL, y, chips);
    y += CHIP_H + CHIP_GAP;
  }
  return y - CHIP_GAP;
}

interface Lane { key: string; name: string | null; chains: GraphNode[][][]; solo: GraphNode[]; done: ProductFeature[]; minRank: number; prio: number }

/** 泳道：先按 areas 的顺序，再按链上最小层号、泳道内最高优先级稳定排；未分组恒在最后 */
function lanesOf(g: ReturnType<typeof productGraph>, areas: readonly ProductArea[]): Lane[] {
  const keys = new Set(areas.map(a => a.id));
  const lanes = [...areas.map(a => ({ key: a.id, name: a.name })), { key: '', name: null }].map((a): Lane => {
    const mine = (n: GraphNode) => areaKey(n.feature, keys) === a.key;
    const chains = g.chains.map(cols => cols.map(c => c.filter(mine))).filter(cols => cols.some(c => c.length));
    const solo = g.solo.filter(mine);
    const main = [...chains.flat(2), ...solo].filter(n => !n.chip);
    return { ...a, chains, solo, done: g.done.filter(f => areaKey(f, keys) === a.key),
      minRank: Math.min(Infinity, ...chains.flat(2).map(n => n.rank)), prio: Math.min(9, ...main.map(n => PRIO[n.state] ?? 9)) };
  });
  const tail = lanes.pop()!;
  lanes.sort((a, b) => (a.minRank - b.minRank || 0) || a.prio - b.prio);
  return tail.chains.length || tail.solo.length || tail.done.length ? [...lanes, tail] : lanes;
}

function layoutLane(g: ReturnType<typeof productGraph>, areas: readonly ProductArea[], o: LayoutOpts, height: Height, out: Placed, zones: ProductZone[],
  chips: ProductChip[]): number {
  let y = PAD;
  const x0 = PAD + LANE_PAD;
  const frames: ProductZone[] = [];
  for (const lane of lanesOf(g, areas)) {
    const open = (o.laneDone ?? []).includes(lane.key);
    const frame: ProductZone = { id: `lane:${lane.key}`, kind: 'lane', x: PAD, y, w: 0, h: 0, label: lane.name,
      words: [...(lane.name === null ? [{ w: '未分组' }] : []), { w: '{n} 在跑', n: [...lane.chains.flat(2), ...lane.solo].filter(n => n.state === 'run').length }],
      lane: { key: lane.key, done: lane.done.length, open } };
    let cy = y + LANE_PAD + HEAD + HEAD_GAP;
    for (const cols of lane.chains) {
      const ids = new Set(cols.flat().map(n => n.id));
      cy += placeChain(cols, cy, n => x0 + n.rank * COL, height, hasBack(ids, g.edges), out) + ROW_GAP;
    }
    cy += placeGrid(lane.solo, x0, cy, height, out).h + (lane.solo.length ? ROW_GAP : 0);
    if (open && lane.done.length) {
      chipRow(lane.done, `lane-done:${lane.key}`, () => 'done', x0, cy, chips);
      cy += CHIP_H + ROW_GAP;
    }
    frame.h = Math.max(cy - ROW_GAP, y + LANE_PAD + HEAD) - y + LANE_PAD;
    frames.push(frame);
    zones.push(frame);
    y += frame.h + LANE_GAP;
  }
  const right = Math.max(PAD + 2 * LANE_PAD + 2 * CARD_W, ...out.nodes.map(n => n.x + n.w + LANE_PAD), ...chips.map(c => c.x + c.w + LANE_PAD));
  for (const f of frames) f.w = right - PAD;
  return y - LANE_GAP;
}

/** 边：两端都摆上了才画。back 边从两端底部绕到带子下面 */
function edgeViews(edges: readonly GraphEdge[], placed: Placed): ProductEdgeView[] {
  const at = new Map(placed.nodes.map(n => [n.id, n]));
  return edges.flatMap((e): ProductEdgeView[] => {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) return [];
    const note = [...e.deps.map(d => d.note), ...e.links.map(l => l.note)].filter(Boolean).join('\n');
    const base = { ...e, note, solid: e.satisfied && !e.kinds.includes('lock') };
    if (!e.back) return [{ ...base, x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2, loopY: null }];
    const low = Math.max(placed.bottom.get(e.from) ?? a.y + a.h, placed.bottom.get(e.to) ?? b.y + b.h);
    return [{ ...base, x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y + b.h, loopY: low + BACK_ROOM - 8 }];
  });
}

function summaryOf(nodes: readonly ProductNode[]): MapSummary {
  const s: MapSummary = { total: 0, run: 0, blocked: 0, stale: 0, ready: 0, gate: 0, wait: 0 };
  for (const n of nodes) if (!n.chip) { s.total++; if (n.state in s) s[n.state as keyof MapSummary]++; }
  return s;
}

export function productLayout(board: ProductBoard, opts: LayoutOpts = {}): ProductCanvas {
  const g = productGraph(board);
  const height = opts.cardHeight ?? defaultHeight;
  const lanesOk = !!board.areas;
  const mode: MapMode = opts.mode === 'lane' && lanesOk ? 'lane' : 'dep';
  const placed: Placed = { nodes: [], bottom: new Map() };
  const zones: ProductZone[] = [], chips: ProductChip[] = [];
  let bottom = mode === 'lane' ? layoutLane(g, board.areas!, opts, height, placed, zones, chips) : layoutDep(g, height, placed, zones);
  if (opts.pausedOpen && g.paused.length) bottom = placeShelf('paused', g.paused, board.areas, bottom + SHELF_GAP, chips, zones);
  if (opts.doneOpen && g.done.length) placeShelf('done', g.done, board.areas, bottom + SHELF_GAP, chips, zones);
  const edges = edgeViews(g.edges, placed);
  const boxes: Box[] = [...placed.nodes, ...chips, ...zones];
  const any = placed.nodes.length + chips.length > 0;
  const w = any ? Math.max(...boxes.map(b => b.x + b.w)) + PAD : 0;
  const h = any ? Math.max(...boxes.map(b => b.y + b.h), ...edges.map(e => e.loopY ?? 0)) + PAD : 0;
  const soloIds = new Set(g.solo.map(n => n.id)), keys = new Set((board.areas ?? []).map(a => a.id));
  const groupOf = (n: ProductNode | ProductChip): string => 'chip' in n
    ? mode === 'lane' ? `lane:${areaKey(n.feature, keys)}` : soloIds.has(n.id) ? 'zone:solo' : 'zone:chains'
    : n.id.startsWith('lane-done:') ? `lane:${n.id.split(':')[1]}` : `shelf:${n.id.split(':')[0]}`;
  return { mode, lanesOk, nodes: placed.nodes, chips, edges, zones, done: g.done, paused: g.paused, summary: summaryOf(placed.nodes), w, h,
    groups: groupsOf([...placed.nodes, ...chips], zones, groupOf), boxOf: new Map([...placed.nodes, ...chips].map(n => [n.id, n.id])) };
}

/** 视口的框：一个区 / 一条泳道 / 一组小标签一个框（含区头），打开时对齐的是带在跑卡的区的左上角，区头不被切掉 */
function groupsOf(items: (ProductNode | ProductChip)[], zones: readonly ProductZone[], groupOf: (n: ProductNode | ProductChip) => string): ViewCanvas['groups'] {
  const by = new Map<string, (ProductNode | ProductChip)[]>();
  for (const n of items) by.set(groupOf(n), [...(by.get(groupOf(n)) ?? []), n]);
  return [...by].map(([id, members]) => {
    const boxes: Box[] = [...members, ...zones.filter(z => z.id === id)];
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y, nodes: members, folds: [] };
  });
}

export function productEta(at: number | null | undefined, now: number, today: string): string | null {
  if (at == null) return null;
  const d = new Date(at), current = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.toDateString() === current.toDateString() ? `${today} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
