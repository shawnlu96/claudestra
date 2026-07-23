"use client";
import { useSyncExternalStore } from "react";

/**
 * 明暗主题偏好（owner 2026-07-24:「桌面和移动端都要能切白天黑夜」）。
 *
 * auto = 不设 data-theme,交给 daisyUI 的 prefersdark 跟随系统;
 * light/dark = <html data-theme> 显式钉住。localStorage 持久化;
 * 首帧防闪由 layout.tsx 的内联脚本在 paint 前应用(本模块只管运行时切换)。
 */
export type ThemePref = "auto" | "light" | "dark";
const KEY = "cstra_theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* 隐私模式 */ }
  return "auto";
}

// 客户端模块加载即读真值(设置面板只在水合后打开,无 SSR 标记不一致问题)
let pref: ThemePref = typeof window !== "undefined" ? read() : "auto";
const subs = new Set<() => void>();

function apply(p: ThemePref) {
  const el = document.documentElement;
  if (p === "auto") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", p);
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    if (p === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch { /* 隐私模式 */ }
  apply(p);
  subs.forEach((f) => f());
}

/** 订阅当前偏好(设置面板高亮用)。SSR 恒 "auto",客户端首次订阅时同步真值。 */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => pref,
    () => "auto" as ThemePref,
  );
}
