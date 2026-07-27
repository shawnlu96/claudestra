"use client";
import { useEffect, useState } from "react";

/**
 * iOS 键盘视口模块（2026-07-27 重构，owner:「直接重构这一块，越改越乱」）。
 * 聊天页与 iOS 软键盘相关的视口逻辑**全部**收在这里——别再散落到 chat.tsx /
 * composer.tsx 里做逐事件 DOM 手术。
 *
 * 背景与死路（都是当天真机踩过的，别回头再试）：
 * - iOS 软键盘不缩布局视口，而是平移 visualViewport / 直接滚 document，把
 *   fixed 壳顶出屏——TopBar 消失，caret / 📎 原生菜单按未平移坐标绘制全部错位。
 * - 死路①：把 fixed 根钉到 vv（top/height 直写壳样式）——和键盘动画打架，
 *   输入框弹跳、点 4 次才唤起键盘，已回滚（87d0515）。
 * - 死路②：viewport meta `interactive-widget=resizes-content`——Safari/iOS
 *   未实现（仅 Chromium 108+），指望不上。
 * - 成立的姿势：terminal-page.tsx（同一台真机验证）——fixed 根**永不动**，
 *   键盘期只钉内层（absolute inset-x-0，top=vv.offsetTop，height=vv.height），
 *   React state 驱动而非直改 DOM。
 *
 * 本模块 = terminal 姿势的 chat 落地 + 实验开关：
 * - localStorage `cstra_kb_fix` === "1" 才启用，默认关。iOS 键盘行为在本机
 *   浏览器里无法模拟，开关让真机试错变成「设置里拨一下」，不再需要发版/回滚。
 * - 返回 {top,height} | null；null = 未启用或键盘不在场，内层保持 inset-0，
 *   与重构前逐像素一致（Playwright 可回归）。
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

export function useKeyboardViewport(): { top: number; height: number } | null {
  const [vp, setVp] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!kbFixEnabled()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // iOS 揭示 focused input 的两条路：滚 document（fixed 层被顶出屏）→
        // 强制归零；vv 平移 → 下面的内层钉扎补偿（terminal-page 同款次序）
        if ((window.scrollY || 0) > 0) window.scrollTo(0, 0);
        const keyboardUp = window.innerHeight - vv.height > 40 || vv.offsetTop > 1;
        setVp((prev) => {
          if (!keyboardUp) return prev === null ? prev : null;
          const next = { top: Math.round(vv.offsetTop), height: Math.round(vv.height) };
          // 值没变不换引用——不触发重渲染，键盘动画期的事件风暴被天然吸收
          return prev && prev.top === next.top && prev.height === next.height ? prev : next;
        });
      });
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, []);
  return vp;
}
