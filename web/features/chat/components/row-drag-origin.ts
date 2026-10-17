/**
 * 行拖拽的起点保护（agents-MOREDRAG1）：从行尾 ⋯（data-row-more）按下再拖，不起整行拖拽。
 * 浏览器对「可拖祖先里的不可拖子元素」起拖时，dragstart 的 target 是祖先（行）本身，
 * 按钮自己的 onDragStart 根本收不到——只能在拖拽源上用 pointerdown capture 记下起点，
 * dragstart 时按起点判定。标记按拖拽源元素存（WeakMap，元素卸载即随之回收），
 * pointerup / pointercancel / dragend 清掉，下一次按下覆盖。
 */

/** 不起整行拖拽的起点：常显 ⋯ 按钮（row-more-button.tsx）。 */
export const NO_DRAG_ORIGIN = "[data-row-more]";

const fromNoDrag = new WeakMap<EventTarget, boolean>();

function inNoDrag(t: EventTarget | null): boolean {
  return !!t && typeof (t as Element).closest === "function" && !!(t as Element).closest(NO_DRAG_ORIGIN);
}

/** pointerdown（capture）：记下这次按下是否落在 ⋯ 上；每次按下都重记。 */
export function markDragOrigin(source: EventTarget, target: EventTarget | null): void {
  fromNoDrag.set(source, inNoDrag(target));
}

/** pointerup / pointercancel / dragend / 卸载：清掉本拖拽源的起点标记。 */
export function clearDragOrigin(source: EventTarget): void {
  fromNoDrag.delete(source);
}

/** dragstart：本次是否该阻止整行拖拽（起点在 ⋯ 上；target 自身在 ⋯ 里也算）。 */
export function dragBlockedByOrigin(source: EventTarget, target: EventTarget | null): boolean {
  return fromNoDrag.get(source) === true || inNoDrag(target);
}
