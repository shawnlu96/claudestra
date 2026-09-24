"use client";
import { useLayoutEffect, type RefObject } from "react";

/**
 * 贴着徽章 absolute 展开的弹层，徽章靠右时会伸出屏幕（窄顶栏里徽章换到第二行后常见）。
 * 打开时量一次，超出左右边就推回来，留 8px 边距；不改定位方式，免得弹层脱离徽章。
 * 用独立的 `translate` 属性而不是 transform：.panel-pop 的进场动画占着 transform，写 transform 会被
 * 动画盖住、动画一结束又跳一下。量的时候按 offsetWidth 还原动画初帧的 scale(0.96)。
 */
export function useKeepInViewport(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    el.style.translate = "";
    const r = el.getBoundingClientRect();
    const left = r.left - (el.offsetWidth - r.width) / 2;
    const right = left + el.offsetWidth;
    const vw = document.documentElement.clientWidth;
    let shift = 0;
    if (right > vw - 8) shift = vw - 8 - right;
    if (left + shift < 8) shift = 8 - left;
    if (shift) el.style.translate = `${Math.round(shift)}px 0`;
  }, [ref, open]);
}
