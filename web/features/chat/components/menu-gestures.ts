"use client";
import { useEffect, useRef } from "react";

/**
 * 浮层菜单的通用手势（气泡菜单 bubble-menu.tsx 与会话行菜单 agent-menu.tsx 共用）：
 * 触摸端长按 450ms 唤出（比 iOS 原生 callout ≈500ms 稍早，抢在它前面）、手指挪超过
 * 12px 视为滚动 / 左滑则作废、桌面右键直接唤出。consumedClick() 给调用方判断
 * 「这次 click 只是长按松手的尾巴」，否则松手会顺带触发行 / 气泡的单击语义。
 */
export const LONG_PRESS_MS = 450;
export const MOVE_TOLERANCE = 12;

export function useLongPressMenu(opts: {
  /** false = 不挂任何 handler（master 行、多选模式） */
  enabled?: boolean;
  /** 返回 true 时本次手势让位（气泡的选字模式） */
  blocked?: () => boolean;
  open: (x: number, y: number) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const firedAt = useRef(0);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const fire = (x: number, y: number) => {
    firedAt.current = Date.now();
    opts.open(x, y);
  };
  const consumedClick = () => Date.now() - firedAt.current < 700;
  if (opts.enabled === false) return { consumedClick, handlers: {} };
  return {
    consumedClick,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        if (opts.blocked?.()) return;
        const t = e.touches[0];
        if (!t) return;
        start.current = { x: t.clientX, y: t.clientY };
        clear();
        timer.current = setTimeout(() => {
          navigator.vibrate?.(8); // 安卓有触感，iOS 无声降级
          fire(start.current!.x, start.current!.y);
        }, LONG_PRESS_MS);
      },
      onTouchMove: (e: React.TouchEvent) => {
        const s = start.current;
        const t = e.touches[0];
        if (!s || !t) return;
        if (Math.abs(t.clientX - s.x) > MOVE_TOLERANCE || Math.abs(t.clientY - s.y) > MOVE_TOLERANCE) clear();
      },
      onTouchEnd: clear,
      onTouchCancel: clear,
      // 桌面右键；安卓 Chrome 的长按也会走这里（和上面的计时器重复触发无害，
      // 后一次只是用同样的内容重开一次）
      onContextMenu: (e: React.MouseEvent) => {
        if (opts.blocked?.()) return;
        e.preventDefault();
        fire(e.clientX, e.clientY);
      },
    },
  };
}

/** 路由变化（返回列表页 / 切会话）时收起——移动端两页同时在 DOM，浮层不会随页卸载。close 须是稳定引用。 */
export function useCloseOnNavigate(close: () => void) {
  useEffect(() => {
    window.addEventListener("hashchange", close);
    window.addEventListener("popstate", close);
    return () => {
      window.removeEventListener("hashchange", close);
      window.removeEventListener("popstate", close);
    };
  }, [close]);
}
