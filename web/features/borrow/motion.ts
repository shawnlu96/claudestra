/**
 * 借入面板的反馈动效（owner：界面反馈用动效不用文字）：成功一闪淡出、失败抖一下、增删淡入淡出。
 * 用 Web Animations API 直接挂在元素上，不加全局 CSS；系统开了「减少动态效果」就只做透明度、不位移。
 */
const reduced = (): boolean => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 保存成功：整行轻微高亮后淡出 */
export function flash(el: HTMLElement | null): void {
  el?.animate?.(
    [{ backgroundColor: "color-mix(in srgb, var(--color-success) 16%, transparent)" }, { backgroundColor: "transparent" }],
    { duration: 1100, easing: "ease-out" },
  );
}

/** 写失败：控件回弹后左右抖一下 */
export function shake(el: HTMLElement | null): void {
  if (!el?.animate) return;
  if (reduced()) {
    el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 300 });
    return;
  }
  el.animate(
    [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }],
    { duration: 320, easing: "ease-in-out" },
  );
}

export function fadeIn(el: HTMLElement | null): void {
  el?.animate?.(
    reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
    { duration: 220, easing: "ease-out" },
  );
}

/** 删掉前淡出；动画跑不了（老浏览器 / 元素已卸载）就直接返回 */
export async function fadeOut(el: HTMLElement | null): Promise<void> {
  const a = el?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" });
  if (!a) return;
  try {
    await a.finished;
  } catch {
    // 动画被取消（元素提前卸载）：照常继续删
  }
}
