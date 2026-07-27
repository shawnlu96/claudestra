"use client";
import { useEffect, useState } from "react";

/**
 * iOS 键盘 / 布局模式模块（2026-07-27 owner:「按 Telegram 网页版的思路改」）。
 *
 * 两种布局模式（设置页实验开关切换,localStorage `cstra_kb_fix`）：
 *
 * - **shell**（默认）：应用壳 `fixed inset-0 overflow-hidden`（claude-os 老方案）。
 *   稳定,但 iOS 弹键盘时会把 fixed 壳向上顶(visualViewport pan),caret /
 *   📎 原生菜单按未平移坐标绘制 → 错位。
 *
 * - **flow**（开关开）：Telegram Web 式文档流布局——应用根是 in-flow 的
 *   `h-dvh` 容器,**没有任何 fixed 祖先**。键盘弹起时布局视口(100dvh)大于
 *   可视视口,文档获得了真实的滚动空间,iOS 用**document 滚动**揭示输入框。
 *   这条路径是每个普通网页都在走的,WebKit 的 caret 绘制完全正确——不需要
 *   任何 JS 补偿。
 *
 * 死路清单（同一晚全部真机踩过,别回头）：
 * ① 把 fixed 根钉到 vv(top/height 直写壳)——和键盘动画打架,输入框弹跳。
 * ② viewport meta interactive-widget=resizes-content——Safari/iOS 未实现。
 * ③ focusin 瞬间预钉(缓存键盘高度提前布局)——聚焦到键盘 settle 之间的
 *    任何布局变更都会把键盘打掉,稳定打不开。
 * ④ settle 后钉 fixed 壳内层——能用,但「iOS 先顶 → 停稳再拉回」的过渡
 *    肉眼可见,owner 不接受。→ 于是有了 flow 模式。
 */

export const KB_FIX_KEY = "cstra_kb_fix";

export function kbFixEnabled(): boolean {
  try {
    return localStorage.getItem(KB_FIX_KEY) === "1";
  } catch {
    return false;
  }
}

export function setKbFixEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KB_FIX_KEY, "1");
    else localStorage.removeItem(KB_FIX_KEY);
  } catch {
    /* 隐私模式 */
  }
}

export type LayoutMode = "shell" | "flow";

/**
 * 当前布局模式。SSR/首帧固定 "shell"（与预渲染 HTML 一致），mount 后读
 * localStorage 切换——flow 用户首帧会闪一下 shell 布局，两者几何相同（都是
 * 全屏容器），肉眼无感。
 */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("shell");
  useEffect(() => {
    if (kbFixEnabled()) setMode("flow");
  }, []);
  return mode;
}

/**
 * flow 模式的唯一 JS：键盘收起后的滚动残留清理。
 *
 * 键盘期 iOS 滚动 document 揭示输入框（这正是 flow 模式的机制,别去拦!）;
 * 键盘收起后滚动范围回到 0,iOS 通常会自己弹回,但偶发残留 scrollY>0——
 * 内容整体上移一截。失焦后延迟检查,有残留就归零。
 */
export function useFlowScrollCleanup(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocusOut = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const el = document.activeElement as HTMLElement | null;
        const editing =
          el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
        if (!editing && (window.scrollY || 0) > 0) window.scrollTo(0, 0);
      }, 350);
    };
    document.addEventListener("focusout", onFocusOut);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [enabled]);
}
