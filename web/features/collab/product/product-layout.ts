import type { ProductBoard, ProductFeature } from '../../../lib/api/product-board-types';
import type { ViewCanvas } from '../v4/canvas-view';

export interface ProductNode { id: string; kind: string; feature: ProductFeature; x: number; y: number; w: number; h: number; column: number }
export interface ProductCanvas extends ViewCanvas {
  nodes: ProductNode[];
  done: ProductFeature[];
  fold: { id: string; x: number; y: number; w: number; h: number; members: string[] } | null;
  edges: { id: string; x1: number; y1: number; x2: number; y2: number; solid: boolean; note: string }[];
}
const W = 258, H = 142, GAP = 72, ROW = 24, PAD = 16;

/** Longest paths in the acyclic portion; cyclic leftovers get a stable finite column rather than recursive traversal. */
export function productLayout(board: ProductBoard, doneOpen = false): ProductCanvas {
  const done = board.features.filter(f => f.status === 'done');
  const all = board.features.filter(f => f.status !== 'dropped');
  const visible = all.filter(f => f.status !== 'done' || doneOpen);
  const ids = new Set(all.map(f => f.id));
  const deps = board.deps.filter(d => ids.has(d.from) && ids.has(d.to));
  const incoming = new Map(all.map(f => [f.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const d of deps) {
    incoming.set(d.to, (incoming.get(d.to) ?? 0) + 1);
    outgoing.set(d.from, [...(outgoing.get(d.from) ?? []), d.to]);
  }
  const columns = new Map(all.map(f => [f.id, 0]));
  const queue = all.filter(f => !incoming.get(f.id)).map(f => f.id);
  const visited = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    visited.add(id);
    for (const to of outgoing.get(id) ?? []) {
      columns.set(to, Math.max(columns.get(to) ?? 0, (columns.get(id) ?? 0) + 1));
      incoming.set(to, (incoming.get(to) ?? 1) - 1);
      if (!incoming.get(to)) queue.push(to);
    }
  }
  const cycleColumn = visited.size ? Math.max(...[...visited].map(id => columns.get(id) ?? 0)) + 1 : 0;
  const fold = !doneOpen && done.length ? { id: 'product:done', x: PAD, y: PAD, w: W, h: 60, members: done.map(f => f.id) } : null;
  const rows = new Map<number, number>();
  const nodes = visible.map(feature => {
    const column = visited.has(feature.id) ? columns.get(feature.id) ?? 0 : cycleColumn;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { id: feature.id, kind: feature.counts.active ? 'full' : 'idle', feature,
      x: PAD + column * (W + GAP), y: PAD + row * (H + ROW) + (fold && column === 0 ? fold.h + ROW : 0), w: W, h: H, column };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const featureOf = new Map(all.map(f => [f.id, f]));
  const edges = deps.flatMap((d, i) => {
    const from = byId.get(d.from) ?? fold, to = byId.get(d.to) ?? fold;
    if (!from || !to || from.id === to.id) return [];
    return [{ id: `${d.from}:${d.to}:${i}`, x1: from.x + from.w, y1: from.y + from.h / 2, x2: to.x, y2: to.y + to.h / 2,
      solid: featureOf.get(d.from)?.status === 'done', note: d.note }];
  });
  const boxes = [...nodes, ...(fold ? [fold] : [])];
  const w = boxes.length ? Math.max(...boxes.map(n => n.x + n.w)) + PAD : 0;
  const h = boxes.length ? Math.max(...boxes.map(n => n.y + n.h)) + PAD : 0;
  const groups: ViewCanvas['groups'] = [...nodes.map(n => ({ ...n, nodes: [n], folds: [] })),
    ...(fold ? [{ ...fold, nodes: [], folds: [fold] }] : [])];
  return { nodes, done, fold, edges, w, h, groups, boxOf: new Map(nodes.map(n => [n.id, n.id])) };
}

export function productEta(at: number | null | undefined, now: number, today: string): string | null {
  if (at == null) return null;
  const d = new Date(at), current = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.toDateString() === current.toDateString() ? `${today} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
