"use client";
import { useSyncExternalStore } from "react";
import { buildThemeCss, type ThemeVarsText } from "./theme-vars-parse";

export { parseThemeVars, buildThemeCss } from "./theme-vars-parse";
export type { ThemeVarsText, VarEntry } from "./theme-vars-parse";

/**
 * 自定义主题变量(owner 2026-09-25 探索分支第 ① 期)的存储与注入：把 daisyui.com/theme-generator
 * 生成的整段粘进来，运行时覆盖 CSS 变量，不重新 build。解析与拼 CSS 在 ./theme-vars-parse.ts。
 * 按设备存(localStorage)，与明暗偏好(lib/theme.ts)同一层；首帧由 layout.tsx 的内联脚本
 * 读 CSS_KEY 直接注入，避免暗色自定义先闪一帧默认色。
 */
export const STYLE_ID = "cstra-theme-vars";
export const TEXT_KEY = "cstra_theme_vars";
export const CSS_KEY = "cstra_theme_vars_css";

const EMPTY: ThemeVarsText = { light: "", dark: "" };

function read(): ThemeVarsText {
  try {
    const raw = localStorage.getItem(TEXT_KEY);
    if (!raw) return EMPTY;
    const j = JSON.parse(raw) as Partial<ThemeVarsText>;
    return { light: typeof j.light === "string" ? j.light : "", dark: typeof j.dark === "string" ? j.dark : "" };
  } catch {
    return EMPTY; // 隐私模式或损坏的存储：按未设置处理，页面照常渲染
  }
}

let current: ThemeVarsText = typeof window !== "undefined" ? read() : EMPTY;
const subs = new Set<() => void>();

function applyCss(css: string) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el); // 排在所有样式表之后，同特异性时后者赢
  }
  el.textContent = css;
}

/** 保存 + 立即生效；两段都空 = 恢复默认（清存储、摘掉 style）。 */
export function setThemeVars(next: ThemeVarsText) {
  current = { light: next.light, dark: next.dark };
  const css = buildThemeCss(current);
  try {
    if (!current.light.trim() && !current.dark.trim()) {
      localStorage.removeItem(TEXT_KEY);
      localStorage.removeItem(CSS_KEY);
    } else {
      localStorage.setItem(TEXT_KEY, JSON.stringify(current));
      localStorage.setItem(CSS_KEY, css);
    }
  } catch {
    /* 隐私模式：本次会话内仍生效，只是刷新后丢 */
  }
  applyCss(css);
  subs.forEach((f) => f());
}

export function getThemeVars(): ThemeVarsText {
  return current;
}

/** 订阅已保存的文本（设置面板回填用）。SSR 恒为空。 */
export function useThemeVars(): ThemeVarsText {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
    () => EMPTY,
  );
}
