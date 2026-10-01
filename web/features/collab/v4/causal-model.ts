/**
 * 协作视图 v4「因果线」画布的布局模型（docs/team/collab-view-v4.md），纯函数，单测 tests/web-collab-causal.test.ts。
 * 输入只有台账总览（tasks / items / deps，src/lib/ledger-read.ts projectView）：
 *   - 事项是分组框，框里按依赖从左往右排（列 = 沿依赖的最长路径），没归事项的任务进「未归事项」框；
 *   - 在跑的任务展开成节点（full），上线 / 验证中和还没开工的收成小节点（mini），被挡住、还没开工的按「挡着它的第一个」
 *     折叠成「N 件在等 X」，已完成的只在框角记 ✓ N；ops（PM 自做）不进画布，完成了也记进 ✓ N；
 *   - 边来自 deps，effective 定线型：done 实线、active 流动虚线、waiting 灰点线；两端都画在画布上才画，同一对框只画一根——
 *     指向折叠组的往往是好几条依赖，合成一根：线型取最「活」的（active > waiting > done），代表边按固定顺序挑，deps 里留全部。
 */
import type { LedgerDepView, LedgerOverview, LedgerTaskView, Stage } from "../collab-model";
import { restInItems } from "@/lib/api/ledger-done";

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
const FULL_H = 64, MINI_H = 30, NODE_W = 208, ROW_GAP = 10, PAD = 14, HEAD = 30, GROUP_GAP = 28;
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

function placeGroup(id: string, title: string, slots: Slot[], done: number, top: number): CGroup {
  const base = slots.length ? Math.min(...slots.map((s) => s.rank)) : 0; // 框里最左一列从 0 起，跨事项的依赖不把框撑出空列
  const cols = new Map<number, Slot[]>();
  for (const s of slots) cols.set(s.rank - base, [...(cols.get(s.rank - base) ?? []), s]);
  const nodes: CNode[] = [];
  const folds: CFold[] = [];
  let tallest = 0;
  for (const [col, list] of cols) {
    let y = top + HEAD;
    for (const s of list) {
      const h = s.kind === "full" ? FULL_H : MINI_H;
      const box = { x: PAD + col * (NODE_W + COL_GAP), y, w: NODE_W, h };
      if (s.kind === "fold") folds.push({ ...box, id: s.id, waitFor: s.waitFor!, members: s.members! });
      else nodes.push({ ...box, id: s.id, kind: s.kind, task: s.task! });
      y += h + ROW_GAP;
    }
    tallest = Math.max(tallest, y - ROW_GAP - (top + HEAD));
  }
  const ncols = Math.max(1, cols.size ? Math.max(...cols.keys()) + 1 : 1);
  return { id, title, nodes, folds, done, x: 0, y: top, w: ncols * NODE_W + (ncols - 1) * COL_GAP + PAD * 2, h: HEAD + Math.max(tallest, MINI_H) + PAD };
}

export function causalCanvas(ov: Pick<LedgerOverview, "tasks" | "items" | "deps" | "doneRest">): Canvas {
  const deps = ov.deps ?? [];
  const drawn = ov.tasks.filter((t) => t.kind !== "ops" && !TERMINAL.has(t.stage));
  const rank = ranks(drawn.map((t) => t.id), deps);
  const order = [...ov.items.map((i) => ({ id: i.id, title: i.title })), { id: LOOSE_GROUP, title: "" }];
  const known = new Set(ov.items.map((i) => i.id));
  const groupOf = (t: LedgerTaskView) => (t.itemId && known.has(t.itemId) ? t.itemId : LOOSE_GROUP);
  const groups: CGroup[] = [];
  let top = 0;
  for (const g of order) {
    const mine = drawn.filter((t) => groupOf(t) === g.id);
    // 窗口外的已完成卡只有按事项的计数（ov.doneRest）：未归事项框收没归事项的和挂在不认识的事项上的
    const restIds = g.id === LOOSE_GROUP ? Object.keys(ov.doneRest?.byItem ?? {}).filter((id) => !known.has(id)) : [g.id];
    const done = ov.tasks.filter((t) => groupOf(t) === g.id && t.stage === "done").length + restInItems(ov, restIds, "done");
    if (!mine.length && !done) continue;
    const group = placeGroup(g.id, g.title, slotsOf(g.id, mine, rank), done, top);
    groups.push(group);
    top += group.h + GROUP_GAP;
  }
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
  return { groups, edges, w: Math.max(0, ...groups.map((g) => g.w)), h: Math.max(0, top - GROUP_GAP), boxOf };
}
