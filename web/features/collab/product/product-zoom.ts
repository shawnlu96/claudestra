/** 项目地图的独立视口策略；任务画布仍沿用 v4 的文字下限。 */
import { initialView, VIEW_PAD, type View, type ViewCanvas } from '../v4/canvas-view';
import type { MapMode, ProductCanvas } from './product-layout';

export const PRODUCT_MIN_K = 0.45;
export const FAR_K = 0.62;
export const zoomTier = (k: number): 'far' | 'near' => k < FAR_K ? 'far' : 'near';
const clamp = (k: number, min: number) => Math.min(1, Math.max(min, k));

/** 区头只有标题高度；链区的实际边界取它对应的框，含全部卡片。 */
export function productInitialView(layout: ProductCanvas, mode: MapMode) {
  return (c: ViewCanvas, vw: number, vh: number): View => {
    if (mode === 'lane') {
      return { x: VIEW_PAD, y: VIEW_PAD, k: c.w ? clamp((vw - VIEW_PAD * 2) / c.w, PRODUCT_MIN_K) : 1 };
    }
    const head = layout.zones.find(z => z.kind === 'chains');
    const chain = head && layout.groups.find(g => g.x === head.x && g.y === head.y);
    if (!chain) return initialView(c, vw, vh, PRODUCT_MIN_K);
    const k = clamp(Math.min((vw - VIEW_PAD * 2) / chain.w, (vh - VIEW_PAD * 2) / chain.h), 0.7);
    return { x: VIEW_PAD - chain.x * k, y: VIEW_PAD - chain.y * k, k };
  };
}

/** 只数独立推进区的卡：右边缘越过视口就算，包括只露出一截的卡。 */
export function singlesOffRight(layout: ProductCanvas, view: View, vw: number): number {
  const solo = layout.zones.find(z => z.kind === 'solo');
  if (!solo || layout.mode !== 'dep') return 0;
  return layout.nodes.filter(n => !n.chip && n.x >= solo.x && n.x + n.w <= solo.x + solo.w
    && view.x + (n.x + n.w) * view.k > vw).length;
}
