/**
 * 协作视图 v4「因果线」画布的布局模型（docs/team/collab-view-v4.md），纯函数，单测 tests/web-collab-causal.test.ts。
 * 输入只有台账总览（tasks / items / deps，src/lib/ledger-read.ts projectView）：
 *   - 事项是分组框，框里按依赖从左往右排（列 = 沿依赖的最长路径），没归事项的任务进「未归事项」框；框按视口宽度成行排，
 *     太长的列拆成并排小列（causalCanvas 的 size）；
 *   - 在跑的任务展开成节点（full），上线 / 验证中和还没开工的收成小节点（mini），被挡住、还没开工的按「挡着它的第一个」
 *     折叠成「N 件在等 X」，已完成的只在框角记 ✓ N；ops（PM 自做）不进画布，完成了也记进 ✓ N；
 *   - 边来自 deps，effective 定线型：done 实线、active 流动虚线、waiting 灰点线；两端都画在画布上才画，同一对框只画一根——
 *     指向折叠组的往往是好几条依赖，合成一根：线型取最「活」的（active > waiting > done），代表边按固定顺序挑，deps 里留全部。
 */
import type { LedgerDepView, LedgerOverview, LedgerTaskView, Stage } from "../collab-model";

export type NodeKind = "full" | "mini";
export type EdgeStyle = "solid" | "flow" | "dotted";
export interface Box { x: number; y: number; w: number; h: number }
export interface CNode extends Box { id: string; kind: NodeKind; task: LedgerTaskView }
export interface CFold extends Box { id: string; waitFor: string; members: string[] }
export interface CGroup extends Box { id: string; title: string; nodes: CNode[]; folds: CFold[]; done: number }
export interface CEdge {
  /** 框对（`框>框`），刷新之间稳定 */
  id: string; from: string; to: string; style: EdgeStyle;
  /** 代表边（最活的那条）与合进这根线的全部依赖；label = 条件原文，多条且条件不同时带「+N」 */
  dep: LedgerDepView; deps: LedgerDepView[]; label: string;
  x1: number; y1: number; x2: number; y2: number;
}
export interface Canvas {
  groups: CGroup[];
  edges: CEdge[];
  w: number;
  h: number;
  /** 任务 id → 它画在哪个框里（自己的节点，或折叠它的那一组） */
  boxOf: Map<string, string>;
}

export const LOOSE_GROUP = "__loose";
/** 列间距要放得下一个边标签（canvas-view.ts placeLabels 把标签放在列缝里，宽度以它为上限） */
export const COL_GAP = 96;
/** 同一深度拆出来的小列之间没有边要过，缝窄一些 */
const SUB_GAP = 16;
const FULL_H = 64, MINI_H = 30, NODE_W = 208, ROW_GAP = 10, PAD = 14, HEAD = 30, GROUP_GAP = 28;
/** 视口留白（canvas-view.ts 摆视口也用它）；布局宽度按 BUCKET 分桶 */
export const VIEW_PAD = 24;
const BUCKET = 80;
export interface Size { width: number; height: number }
const FALLBACK: Size = { width: 1200, height: 800 };
const FULL: ReadonlySet<Stage> = new Set(["restate", "build", "review", "fix", "merge", "blocked"]);
const NOT_STARTED: ReadonlySet<Stage> = new Set(["spec", "restate"]);
const TERMINAL: ReadonlySet<Stage> = new Set(["done", "cancelled"]);

export const edgeStyle = (effective: LedgerDepView["effective"]): EdgeStyle => (effective === "done" ? "solid" : effective === "active" ? "flow" : "dotted");
const ALIVE: Record<LedgerDepView["effective"], number> = { active: 0, waiting: 1, done: 2 };
const byAlive = (a: LedgerDepView, b: LedgerDepView) => ALIVE[a.effective] - ALIVE[b.effective] || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);

/** 列 = 沿依赖的最长路径（只算画在画布上的任务之间的边）；有环就在环上停，不死循环 */
function ranks(ids: readonly string[], deps: readonly LedgerDepView[]): Map<string, number> {
  const inSet = new Set(ids);
  const preds = new Map<string, string[]>();
  for (const d of deps) if (inSet.has(d.from) && inSet.has(d.to)) preds.set(d.to, [...(preds.get(d.to) ?? []), d.from]);
  const memo = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (seen.has(id)) return 0;
    seen.add(id);
    const r = Math.max(-1, ...(preds.get(id) ?? []).map((p) => visit(p, seen))) + 1;
    seen.delete(id);
    memo.set(id, r);
    return r;
  };
  for (const id of ids) visit(id, new Set());
  return memo;
}

const STAGE_ORDER: Stage[] = ["blocked", "fix", "review", "build", "merge", "restate", "live", "verified", "spec"];
const byStage = (a: LedgerTaskView, b: LedgerTaskView) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.id.localeCompare(b.id);

interface Slot { id: string; kind: NodeKind | "fold"; rank: number; task?: LedgerTaskView; waitFor?: string; members?: string[] }

/** 一个事项框里的格子：节点、小节点、折叠组，各带列号 */
function slotsOf(group: string, tasks: LedgerTaskView[], rank: Map<string, number>): Slot[] {
  const folds = new Map<string, LedgerTaskView[]>();
  const slots: Slot[] = [];
  for (const t of [...tasks].sort(byStage)) {
    const blocker = t.blockedBy?.[0];
    if (blocker && NOT_STARTED.has(t.stage)) folds.set(blocker, [...(folds.get(blocker) ?? []), t]);
    else slots.push({ id: t.id, kind: FULL.has(t.stage) ? "full" : "mini", rank: rank.get(t.id) ?? 0, task: t });
  }
  for (const [waitFor, members] of folds) {
    slots.push({ id: `fold:${group}:${waitFor}`, kind: "fold", rank: Math.min(...members.map((m) => rank.get(m.id) ?? 0)), waitFor, members: members.map((m) => m.id) });
  }
  return slots;
}

/** 一个深度列拆成几条小列：每条最多 rows 格；有往外连线的排在后面，落在最右那条小列，边少压过兄弟节点 */
function splitCols(slots: Slot[], hasOut: ReadonlySet<string>, rows: number): Slot[][][] {
  const byRank = new Map<number, Slot[]>();
  for (const s of slots) byRank.set(s.rank, [...(byRank.get(s.rank) ?? []), s]);
  // 深度按出现过的排序后压紧：跨事项的依赖不把框撑出空列
  return [...byRank].sort((a, b) => a[0] - b[0]).map(([, list]) => {
    const out = (s: Slot) => (s.kind === "fold" ? s.members!.some((m) => hasOut.has(m)) : hasOut.has(s.id)) ? 1 : 0;
    const sorted = [...list].sort((a, b) => out(a) - out(b));
    return Array.from({ length: Math.ceil(sorted.length / rows) }, (_, i) => sorted.slice(i * rows, (i + 1) * rows));
  });
}

const slotH = (s: Slot) => (s.kind === "full" ? FULL_H : MINI_H);
const stackH = (list: Slot[]) => list.reduce((h, s) => h + slotH(s) + ROW_GAP, -ROW_GAP);

function measure(cols: Slot[][][]): { w: number; h: number } {
  const subs = cols.reduce((n, c) => n + c.length, 0);
  const w = subs * NODE_W + (subs - cols.length) * SUB_GAP + Math.max(0, cols.length - 1) * COL_GAP + PAD * 2;
  return { w, h: HEAD + Math.max(MINI_H, ...cols.flat().map(stackH)) + PAD };
}

/** 行数上限：框的宽高比最接近视口的那个，且优先宽度放得进视口（都放不进就取最窄的） */
function pickRows(slots: Slot[], hasOut: ReadonlySet<string>, view: Size): Slot[][][] {
  const longest = Math.max(1, ...countByRank(slots).values());
  let best: { cols: Slot[][][]; score: number } | null = null;
  for (let rows = 1; rows <= longest; rows++) {
    const cols = splitCols(slots, hasOut, rows), { w, h } = measure(cols);
    const score = (w > view.width ? 100 + w / view.width : 0) + Math.abs(Math.log(w / h) - Math.log(view.width / view.height));
    if (!best || score < best.score) best = { cols, score };
  }
  return best!.cols;
}

function countByRank(slots: Slot[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of slots) m.set(s.rank, (m.get(s.rank) ?? 0) + 1);
  return m;
}

/** 框内坐标（框左上角为原点），摆到画布上时再整体平移 */
function placeGroup(id: string, title: string, slots: Slot[], done: number, cols: Slot[][][]): CGroup {
  const nodes: CNode[] = [];
  const folds: CFold[] = [];
  let x = PAD;
  for (const col of cols) {
    for (const sub of col) {
      let y = HEAD;
      for (const s of sub) {
        const box = { x, y, w: NODE_W, h: slotH(s) };
        if (s.kind === "fold") folds.push({ ...box, id: s.id, waitFor: s.waitFor!, members: s.members! });
        else nodes.push({ ...box, id: s.id, kind: s.kind, task: s.task! });
        y += box.h + ROW_GAP;
      }
      x += NODE_W + SUB_GAP;
    }
    x += COL_GAP - SUB_GAP;
  }
  const { w, h } = slots.length ? measure(cols) : { w: NODE_W + PAD * 2, h: HEAD + MINI_H + PAD };
  return { id, title, nodes, folds, done, x: 0, y: 0, w, h };
}

const shift = <T extends Box>(b: T, dx: number, dy: number): T => ({ ...b, x: b.x + dx, y: b.y + dy });

/** 事项框按行排（shelf）：这一行放不下才换行；框本身比视口宽的独占一行 */
function shelve(groups: CGroup[], width: number): CGroup[] {
  let x = 0, y = 0, rowH = 0;
  return groups.map((g) => {
    if (x > 0 && x + g.w > width) {
      x = 0;
      y += rowH + GROUP_GAP;
      rowH = 0;
    }
    const placed = { ...shift(g, x, y), nodes: g.nodes.map((n) => shift(n, x, y)), folds: g.folds.map((f) => shift(f, x, y)) };
    x += g.w + GROUP_GAP;
    rowH = Math.max(rowH, g.h);
    return placed;
  });
}

/**
 * size = 画布视口（CausalCanvas 量到的）：宽高按 BUCKET 分桶，拖窗口时不会每个像素都重排；框的形状和换行都按它算。
 * 不给 size（选中解析只要折叠组和 boxOf，与布局无关）就按 FALLBACK 排
 */
export function causalCanvas(ov: Pick<LedgerOverview, "tasks" | "items" | "deps">, size: Size = FALLBACK): Canvas {
  const bucket = (n: number, min: number) => Math.max(min, Math.floor(n / BUCKET) * BUCKET) - VIEW_PAD * 2;
  const view = { width: bucket(size.width, BUCKET * 4), height: bucket(size.height, BUCKET * 3) };
  const deps = ov.deps ?? [];
  const drawn = ov.tasks.filter((t) => t.kind !== "ops" && !TERMINAL.has(t.stage));
  const rank = ranks(drawn.map((t) => t.id), deps);
  const onCanvas = new Set(drawn.map((t) => t.id));
  const hasOut = new Set(deps.filter((d) => onCanvas.has(d.from) && onCanvas.has(d.to)).map((d) => d.from));
  const order = [...ov.items.map((i) => ({ id: i.id, title: i.title })), { id: LOOSE_GROUP, title: "" }];
  const known = new Set(ov.items.map((i) => i.id));
  const groupOf = (t: LedgerTaskView) => (t.itemId && known.has(t.itemId) ? t.itemId : LOOSE_GROUP);
  const local: CGroup[] = [];
  for (const g of order) {
    const mine = drawn.filter((t) => groupOf(t) === g.id);
    const done = ov.tasks.filter((t) => groupOf(t) === g.id && t.stage === "done").length;
    if (!mine.length && !done) continue;
    const slots = slotsOf(g.id, mine, rank);
    local.push(placeGroup(g.id, g.title, slots, done, pickRows(slots, hasOut, view)));
  }
  const groups = shelve(local, view.width);
  const boxes = new Map<string, Box>();
  const boxOf = new Map<string, string>();
  for (const g of groups) {
    for (const n of g.nodes) {
      boxes.set(n.id, n);
      boxOf.set(n.id, n.id);
    }
    for (const f of g.folds) {
      boxes.set(f.id, f);
      for (const m of f.members) boxOf.set(m, f.id);
    }
  }
  const pairs = new Map<string, LedgerDepView[]>();
  for (const d of deps) {
    const a = boxOf.get(d.from), b = boxOf.get(d.to);
    if (!a || !b || a === b) continue;
    pairs.set(`${a}>${b}`, [...(pairs.get(`${a}>${b}`) ?? []), d]);
  }
  const edges: CEdge[] = [...pairs].map(([id, list]) => {
    const all = [...list].sort(byAlive), dep = all[0]!;
    const [a, b] = id.split(">") as [string, string];
    const p = boxes.get(a)!, q = boxes.get(b)!;
    const same = all.every((d) => d.when === dep.when);
    const label = same || !dep.when ? dep.when : `${dep.when} +${all.length - 1}`;
    return { id, from: a, to: b, style: edgeStyle(dep.effective), dep, deps: all, label, x1: p.x + p.w, y1: p.y + p.h / 2, x2: q.x, y2: q.y + q.h / 2 };
  });
  return { groups, edges, w: Math.max(0, ...groups.map((g) => g.x + g.w)), h: Math.max(0, ...groups.map((g) => g.y + g.h)), boxOf };
}
