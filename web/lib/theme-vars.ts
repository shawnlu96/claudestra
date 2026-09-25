"use client";
import { createCssPrefStore } from "./css-pref-store";
import { buildThemeCss, type ThemeVarsText } from "./theme-vars-parse";

export { parseThemeVars, buildThemeCss } from "./theme-vars-parse";
export type { ThemeVarsText, VarEntry } from "./theme-vars-parse";

/**
 * 自定义主题变量(owner 2026-09-25 探索分支第 ① 期)：把 daisyui.com/theme-generator 生成的整段
 * 粘进来，运行时覆盖 CSS 变量，不重新 build。解析与拼 CSS 在 ./theme-vars-parse.ts，
 * 存储 / 注入 / 首帧见 ./css-pref-store.ts。
 */
export const STYLE_ID = "cstra-theme-vars";
export const TEXT_KEY = "cstra_theme_vars";
export const CSS_KEY = "cstra_theme_vars_css";

const EMPTY: ThemeVarsText = { light: "", dark: "" };

const store = createCssPrefStore<ThemeVarsText>({
  textKey: TEXT_KEY,
  cssKey: CSS_KEY,
  styleId: STYLE_ID,
  empty: EMPTY,
  normalize: (raw) => {
    const j = (raw ?? {}) as Partial<ThemeVarsText>;
    return { light: typeof j.light === "string" ? j.light : "", dark: typeof j.dark === "string" ? j.dark : "" };
  },
  isEmpty: (v) => !v.light.trim() && !v.dark.trim(),
  build: buildThemeCss,
});

export const getThemeVars = store.get;
export const setThemeVars = store.set;
export const useThemeVars = store.useValue;
