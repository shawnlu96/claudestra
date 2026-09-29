"use client";
import { useRef } from "react";
import { swipeDir } from "./hash-nav";
import { isNarrow } from "./hash-nav-browser";

type SwipeStart = { x: number; y: number; hscroll: boolean };

/**
 * 手机上的横滑手势（主屏 PWA 没有系统返回手势，全靠它）：右滑 = back，左滑 = forward，阈值见 hash-nav swipeDir。
 * 起点在横向可滚容器里（代码块等）不启用，免得劫持它的滚动。stop = 截住冒泡：portal 出去的全屏层（「待你处理」抽屉）
 * 的触摸事件会沿 React 树冒到会话壳，不截的话在抽屉里左滑会把背后切到会话页。
 */
export function useBackSwipe(on: { back?: () => void; forward?: () => void }, stop = false) {
  const start = useRef<SwipeStart | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (stop) e.stopPropagation();
    if (!isNarrow() || e.touches.length !== 1) {
      start.current = null;
      return;
    }
    let el = e.target as HTMLElement | null;
    let hscroll = false;
    while (el && el !== e.currentTarget) {
      if (el.scrollWidth - el.clientWidth > 4) {
        hscroll = true;
        break;
      }
      el = el.parentElement;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, hscroll };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (stop) e.stopPropagation();
    const s = start.current;
    start.current = null;
    if (!s || s.hscroll) return;
    const t = e.changedTouches[0];
    const dir = swipeDir(t.clientX - s.x, t.clientY - s.y);
    if (dir) on[dir]?.();
  };
  return { onTouchStart, onTouchEnd };
}
