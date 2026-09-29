/**
 * 因果线画布的几何（纯函数，单测 tests/web-collab-causal.test.ts）：边的曲线、边标签避让、打开时的视口、视口外还剩几件。
 * 标签按边的先后逐个找位置：沿曲线试几个点、再上下错开，压到节点或别的标签就换下一个，全都压到就退成一个点
 * （悬停看全文，点开右侧属性页）。标签宽度是按字数估的，跟实际渲染差几个像素，所以碰撞判断留了余量。
 */
import type { Box, Canvas, CEdge } from "./causal-model";

export interface View { x: number; y: number; k: number }
export interface EdgeLabel { id: string; x: number; y: number; w: number; h: number; dot: boolean }

export const VIEW_PAD = 24;
/** 打开时缩放不低于它：再小字就认不出，宁可有几件在视口外（给出提示），整张看点「适配全部」 */
export const READABLE_K = 0.8;
const LABEL_H = 18, LABEL_MAX_W = 150, GAP = 3;
const TRY_T = [0.5, 0.35, 0.65, 0.22, 0.78];
const TRY_DY = [0, -(LABEL_H + GAP), LABEL_H + GAP];

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

/** 估宽：中文按 10.5px、其余按 6px，再加内边距；和 .elabel 的 max-width 同一个上限 */
export function labelWidth(text: string): number {
  let w = 14;
  for (const ch of text) w += /[⺀-￿]/.test(ch) ? 10.5 : 6;
  return Math.min(LABEL_MAX_W, Math.ceil(w));
}

const hits = (a: Box, b: Box) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

export function placeLabels(edges: readonly CEdge[], obstacles: readonly Box[]): EdgeLabel[] {
  const placed: Box[] = [];
  return edges.filter((e) => e.dep.when).map((e) => {
    const w = labelWidth(e.dep.when);
    for (const t of TRY_T) {
      const p = pointAt(e, t);
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

const boxesOf = (c: Canvas) => c.groups.flatMap((g) => [...g.nodes.map((n) => ({ box: n as Box, n: 1, hot: n.kind === "full" })),
  ...g.folds.map((f) => ({ box: f as Box, n: f.members.length, hot: false }))]);

/**
 * 打开时的视口：整张能在 READABLE_K 以上放下就整张放下；放不下就用 READABLE_K，
 * 把在跑的节点（full）那一块对齐到左上角——它们是打开这页最想看的，剩下的由 offscreen 提示
 */
export function initialView(c: Canvas, vw: number, vh: number): View {
  const fit = Math.min(1, (vw - VIEW_PAD * 2) / c.w, (vh - VIEW_PAD * 2) / c.h);
  if (!c.w || fit >= READABLE_K) return { x: VIEW_PAD, y: VIEW_PAD, k: fit || 1 };
  const all = boxesOf(c);
  const hot = all.some((b) => b.hot) ? all.filter((b) => b.hot) : all;
  const x0 = Math.min(...hot.map((b) => b.box.x)), y0 = Math.min(...hot.map((b) => b.box.y));
  return { x: VIEW_PAD - x0 * READABLE_K, y: VIEW_PAD - y0 * READABLE_K, k: READABLE_K };
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
