/**
 * 因果线画布的几何（纯函数，单测 tests/web-collab-causal.test.ts）：边的曲线、边标签避让、视口（打开时摆一次、明确选中才居中、
 * 数据刷新不动用户拖好的位置、「适配全部」）、视口外还剩几件。
 * 标签放在列缝里（出发节点右边那道缝、到达节点左边那道缝，都不行再沿曲线试），每处再上下错开几档；压到节点或别的标签就换，
 * 全都压到就退成一个点（悬停看全文，点开右侧属性页）。宽度按字数估、以列缝为上限，放不全的省略号截断、悬停看全文。
 */
import { COL_GAP, VIEW_PAD, type Box, type Canvas, type CEdge } from "./causal-model";

export interface View { x: number; y: number; k: number }
/** 外面要求居中到某个任务；seq 每次点都 +1，同一个任务再点一次也会再居中 */
export interface Focus { id: string; seq: number }
/** placed = 打开时的摆放做过了；centered = 最后处理过的 Focus.seq */
export interface ViewState { view: View; placed: boolean; centered: number }
export interface EdgeLabel { id: string; x: number; y: number; w: number; h: number; dot: boolean }

/**
 * 缩放下限：节点标题基准 12.5px（--fs-2），乘 0.96 正好 12px，再小就认不出。打开时、「适配全部」、滚轮缩小共用它，
 * 放不下就平移（拖拽）；布局已经按视口宽度排过（causal-model.ts），大多数项目在这个比例下一屏放得下
 */
export const MIN_K = 0.96, MAX_K = 1.6;
const LABEL_H = 18, GAP = 3, LABEL_MAX_W = COL_GAP - 2 * GAP;
const TRY_T = [0.5, 0.35, 0.65];
const TRY_DY = [0, -1, 1, -2, 2].map((n) => n * (LABEL_H + GAP));

const bend = (e: CEdge) => Math.max(40, Math.abs(e.x2 - e.x1) / 2);

export function edgePath(e: CEdge): string {
  const dx = bend(e);
  return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
}

/** 三次贝塞尔（控制点同 edgePath）上 t 处的点 */
export function pointAt(e: CEdge, t: number): { x: number; y: number } {
  const dx = bend(e), u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * e.x1 + b * (e.x1 + dx) + c * (e.x2 - dx) + d * e.x2, y: a * e.y1 + b * e.y1 + c * e.y2 + d * e.y2 };
}

/** 曲线上横坐标为 x 的点（从左往右的边 x 随 t 单调，二分即可）；x 不在两端之间 = null */
function pointAtX(e: CEdge, x: number): { x: number; y: number } | null {
  if (e.x2 <= e.x1 || x < e.x1 || x > e.x2) return null;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (pointAt(e, mid).x < x) lo = mid;
    else hi = mid;
  }
  return pointAt(e, (lo + hi) / 2);
}

/** 候选锚点：出发那道列缝的中间、到达那道列缝的中间，再是曲线上几处 */
function anchors(e: CEdge): { x: number; y: number }[] {
  const gaps = [pointAtX(e, e.x1 + COL_GAP / 2), pointAtX(e, e.x2 - COL_GAP / 2)].filter((p) => p !== null);
  return [...gaps, ...TRY_T.map((t) => pointAt(e, t))];
}

/** 估宽：中文按 10.5px、其余按 6px，再加内边距；以列缝宽为上限 */
export function labelWidth(text: string): number {
  let w = 14;
  for (const ch of text) w += /[⺀-￿]/.test(ch) ? 10.5 : 6;
  return Math.min(LABEL_MAX_W, Math.ceil(w));
}

const hits = (a: Box, b: Box) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

export function placeLabels(edges: readonly CEdge[], obstacles: readonly Box[]): EdgeLabel[] {
  const placed: Box[] = [];
  return edges.filter((e) => e.label).map((e) => {
    const w = labelWidth(e.label);
    for (const p of anchors(e)) {
      for (const dy of TRY_DY) {
        const box = { x: p.x - w / 2, y: p.y + dy - LABEL_H / 2, w, h: LABEL_H };
        if (obstacles.some((o) => hits(box, o)) || placed.some((o) => hits(box, o))) continue;
        placed.push(box);
        return { id: e.id, x: p.x, y: p.y + dy, w, h: LABEL_H, dot: false };
      }
    }
    const p = pointAt(e, 0.5);
    return { id: e.id, x: p.x, y: p.y, w: 8, h: 8, dot: true };
  });
}

const boxesOf = (c: Canvas) => c.groups.flatMap((g) => [...g.nodes.map((n) => ({ id: n.id, box: n as Box, n: 1 })),
  ...g.folds.map((f) => ({ id: f.id, box: f as Box, n: f.members.length }))]);

/**
 * 打开时的视口：整张能在 MIN_K 以上放下就整张放下；放不下就用 MIN_K，
 * 把有在跑节点（full）的那几个框对齐到左上角——它们是打开这页最想看的，剩下的由 offscreen 提示
 */
export function initialView(c: Canvas, vw: number, vh: number): View {
  const fit = Math.min(1, (vw - VIEW_PAD * 2) / c.w, (vh - VIEW_PAD * 2) / c.h);
  if (!c.w || fit >= MIN_K) return { x: VIEW_PAD, y: VIEW_PAD, k: fit || 1 };
  const live = c.groups.filter((g) => g.nodes.some((n) => n.kind === "full"));
  const hot = live.length ? live : c.groups; // 对齐到框的左上角，框标题和边框不被切掉
  const x0 = Math.min(...hot.map((g) => g.x)), y0 = Math.min(...hot.map((g) => g.y));
  return { x: VIEW_PAD - x0 * MIN_K, y: VIEW_PAD - y0 * MIN_K, k: MIN_K };
}

/** 视口外（含被截掉一截）的任务数，按方向；折叠组按里面的件数算 */
export function offscreen(c: Canvas, v: View, vw: number, vh: number): { right: number; down: number; left: number; up: number } {
  const out = { right: 0, down: 0, left: 0, up: 0 };
  for (const { box: b, n } of boxesOf(c)) {
    const x1 = v.x + b.x * v.k, x2 = v.x + (b.x + b.w) * v.k, y1 = v.y + b.y * v.k, y2 = v.y + (b.y + b.h) * v.k;
    if (x2 > vw) out.right += n;
    else if (y2 > vh) out.down += n;
    else if (x1 < 0) out.left += n;
    else if (y1 < 0) out.up += n;
  }
  return out;
}

/** 「适配全部」：整张放进视口，最大 1、最小 MIN_K；到下限还放不下就从左上角看起，其余靠拖 */
export function fitAllView(c: Canvas, vw: number, vh: number): View {
  if (!c.w || !c.h) return { x: VIEW_PAD, y: VIEW_PAD, k: 1 };
  const k = Math.min(1, (vw - VIEW_PAD * 2) / c.w, (vh - VIEW_PAD * 2) / c.h);
  return { x: VIEW_PAD, y: VIEW_PAD, k: Math.max(MIN_K, k) };
}

/** 任务所在的框（自己的节点，或折叠它的那一组）平移到视口中间，缩放不变 */
function centerOn(v: View, b: Box, vw: number, vh: number): View {
  return { ...v, x: vw / 2 - (b.x + b.w / 2) * v.k, y: vh / 2 - (b.y + b.h / 2) * v.k };
}

/**
 * 每次数据刷新 / 量到新尺寸 / 外面要求居中时调：第一次有图有尺寸就按 initialView 摆；Focus.seq 没处理过就居中一次
 * （框不在画布上也记为处理过，免得它后来出现时突然跳过去）；其余情况原样返回——刷新不动用户的视口
 */
export function reconcileView(st: ViewState, c: Canvas, vw: number, vh: number, focus: Focus | null): ViewState {
  if (!vw) return st;
  let next = st;
  if (!st.placed && c.w > 0) next = { ...next, view: initialView(c, vw, vh), placed: true };
  if (focus && focus.seq !== next.centered) {
    const id = c.boxOf.get(focus.id);
    const b = id ? boxesOf(c).find((x) => x.id === id)?.box : undefined;
    next = { ...next, centered: focus.seq, ...(b ? { view: centerOn(next.view, b, vw, vh) } : {}) };
  }
  return next;
}
