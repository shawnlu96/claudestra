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

/** 焦点在可编辑元素上（textarea/input/contenteditable）——钉扎的前提条件 */
function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable;
}

/** 键盘动画停稳判定的静默窗口。首版逐事件应用,在键盘拉起动画中途 reflow
 *  会把刚弹的键盘打掉(2026-07-27 真机:首次聚焦 100% 闪关)——改为最后一个
 *  vv 事件后 SETTLE_MS 无新事件才应用一次。 */
const SETTLE_MS = 250;

/** 键盘高度缓存(settle 时写入)。预钉的依据:聚焦瞬间(键盘还没动)就按
 *  缓存高度把布局摆到位,input 不会被键盘挡住 → iOS 无需 pan → 「先顶上去
 *  再弹回」的一跳消失(2026-07-27 真机:能用但过渡体验差)。冷首次无缓存,
 *  退化为等 settle(只跳这一次)。 */
const KB_H_KEY = "cstra_kb_h";

export function useKeyboardViewport(): { top: number; height: number } | null {
  const [vp, setVp] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!kbFixEnabled()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const compute = () => {
      timer = null;
      // iOS 揭示 focused input 的两条路：滚 document（fixed 层被顶出屏）→
      // 强制归零；vv 平移 → 内层钉扎补偿（terminal-page 同款次序）
      if ((window.scrollY || 0) > 0) window.scrollTo(0, 0);
      // 钉扎前提 = 键盘在场 **且** 焦点在可编辑元素上。只看 vv 的话,📎 原生
      // 菜单/系统 UI 也会挤 vv,层被钉进键盘态回不来(2026-07-27 真机:点完
      // 📎 输入框顶到最上、下方 3/4 空白)
      const keyboardUp = (window.innerHeight - vv.height > 40 || vv.offsetTop > 1) && editableFocused();
      if (keyboardUp) {
        // 键盘高度落缓存——下次聚焦的预钉依据
        try {
          localStorage.setItem(KB_H_KEY, String(Math.round(window.innerHeight - vv.height)));
        } catch { /* 隐私模式 */ }
      }
      setVp((prev) => {
        if (!keyboardUp) return prev === null ? prev : null;
        const next = { top: Math.round(vv.offsetTop), height: Math.round(vv.height) };
        // 值没变不换引用——不触发重渲染
        return prev && prev.top === next.top && prev.height === next.height ? prev : next;
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(compute, SETTLE_MS);
    };
    // ⚠ 死路③(2026-07-27 三迭代实测):focusin 瞬间按缓存高度「预钉」——
    // 聚焦时刻的**任何布局变更**都会把刚拉起的键盘打掉,变成稳定打不开键盘。
    // 结论:布局只能在键盘 settle 之后动;跳变观感交给 chat.tsx 层的过渡动画
    // 缓解(settle 后再动布局不杀键盘,二迭代已证)。
    const onFocusIn = () => {
      if (editableFocused()) schedule();
    };
    // blur(点 📎/切走焦点)立即撤钉,不等 vv 事件——原生菜单在场时 vv 可能
    // 根本不再发事件,层会永远卡在键盘态尺寸。focusout 时 activeElement 还是
    // 旧值,推一拍再判。
    const onFocusOut = () => {
      setTimeout(() => {
        if (!editableFocused()) {
          if (timer) clearTimeout(timer);
          compute();
        }
      }, 50);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      if (timer) clearTimeout(timer);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return vp;
}
