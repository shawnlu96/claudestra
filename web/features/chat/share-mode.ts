/**
 * 分享模式（owner 2026-09-24「会话 header 右侧 share 图标 → 选择模式 → 导出」）的状态：
 * 纯逻辑 + 模块级 store，无 React；渲染在 components/share-ui.tsx / share-dock.tsx。
 *
 * 选择规则：**必然是连续范围**。记两个端点消息 id（不是下标——「显示更早」会往前插入，
 * 下标会漂），渲染时按当前列表顺序换算成 [lo, hi]。点击：
 *  - 没选 → 选中这一条；
 *  - 点在范围外 → 范围扩到这一条（点第 5 再点第 10 = [5,10]，再点第 3 = [3,10]）；
 *  - 点在范围内 → 离得近的那个端点挪到这一条（收缩）；范围只有它自己 → 清空。
 * 单测见 tests/web-share-mode.test.ts。
 */

export interface ShareSel {
  /** 范围两端的消息 id（存的是 id，顺序由 order 决定） */
  a: string;
  b: string;
}

export interface Range {
  lo: number;
  hi: number;
}

/** 当前列表顺序下的 [lo, hi]；任一端点已不在列表里 → null（视为没选） */
export function selRange(sel: ShareSel | null, order: readonly string[]): Range | null {
  if (!sel) return null;
  const ia = order.indexOf(sel.a);
  const ib = order.indexOf(sel.b);
  if (ia < 0 || ib < 0) return null;
  return { lo: Math.min(ia, ib), hi: Math.max(ia, ib) };
}

export function clickSelect(sel: ShareSel | null, id: string, order: readonly string[]): ShareSel | null {
  const idx = order.indexOf(id);
  if (idx < 0) return sel;
  const r = selRange(sel, order);
  if (!r) return { a: id, b: id };
  let lo = r.lo;
  let hi = r.hi;
  if (idx < lo) lo = idx;
  else if (idx > hi) hi = idx;
  else if (lo === hi) return null;
  else if (idx - lo <= hi - idx) lo = idx;
  else hi = idx;
  return { a: order[lo], b: order[hi] };
}

export function inRange(r: Range | null, idx: number): boolean {
  return !!r && idx >= r.lo && idx <= r.hi;
}

// ── 模块级 store ──
export interface ShareState {
  on: boolean;
  sel: ShareSel | null;
}

let state: ShareState = { on: false, sel: null };
const subs = new Set<() => void>();

function commit(next: ShareState): void {
  state = next;
  subs.forEach((f) => f());
}

export function getShare(): ShareState {
  return state;
}

export function subscribeShare(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function setShareOn(on: boolean): void {
  if (on === state.on) return;
  // 退出即清选区：下次进来从零开始，不留上次的范围
  commit({ on, sel: on ? state.sel : null });
}

export function toggleShare(): void {
  setShareOn(!state.on);
}

export function clickMessage(id: string, order: readonly string[]): void {
  commit({ ...state, sel: clickSelect(state.sel, id, order) });
}

export function clearSel(): void {
  if (state.sel) commit({ ...state, sel: null });
}

/** 测试用 */
export function resetShare(): void {
  state = { on: false, sel: null };
}
