/**
 * 弹层的焦点三件事（T57 复审）：打开时移进来、Tab 不出去、关掉还回去。
 * 用在 portal 出去的模态层（手机底部弹层）与贴按钮的下拉：焦点留在背景触发按钮上时，Tab 会走到遮罩后面的控件，
 * 关掉后焦点落在已卸载的节点上 = 落到 body，键盘用户找不到回来的路。
 */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

function focusables(box: HTMLElement): HTMLElement[] {
  return Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** 把焦点移进弹层：第一个可聚焦的元素；没有就弹层本身（需要 tabIndex=-1） */
export function focusInto(box: HTMLElement | null): void {
  if (!box) return;
  (focusables(box)[0] ?? box).focus({ preventScroll: true });
}

/** 挂在弹层的 onKeyDown 上：Tab / Shift+Tab 在弹层内循环 */
export function trapTab(e: { key: string; shiftKey: boolean; preventDefault(): void }, box: HTMLElement | null): void {
  if (e.key !== "Tab" || !box) return;
  const list = focusables(box);
  if (!list.length) {
    e.preventDefault();
    return;
  }
  const first = list[0]!, last = list[list.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !box.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !box.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * 关掉后把焦点还回去：触发按钮还在就回它；不在了（最后一个任务消失、切了会话）就回备用容器（顶栏），
 * 容器本身不可聚焦就给它 tabIndex=-1 再聚焦——总之别让焦点掉到 body。
 */
export function restoreFocus(primary: HTMLElement | null, fallback: HTMLElement | null): void {
  if (primary?.isConnected) {
    primary.focus({ preventScroll: true });
    return;
  }
  const box = fallback?.isConnected ? fallback : document.querySelector<HTMLElement>("header");
  if (!box) return;
  if (!box.hasAttribute("tabindex")) box.setAttribute("tabindex", "-1");
  box.focus({ preventScroll: true });
}
