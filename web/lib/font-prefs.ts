"use client";
import { createCssPrefStore } from "./css-pref-store";
import { EMPTY_FONT_PREFS, buildFontCss, isEmptyFontPrefs, normalizeFontPrefs, type FontPrefs } from "./font-prefs-parse";

export type { FontPrefs } from "./font-prefs-parse";
export { EMPTY_FONT_PREFS, cleanFamily } from "./font-prefs-parse";

/**
 * 全局字体偏好(owner 2026-09-25 探索分支第 ② 期)：正文 / 衬线 / 等宽三族 + 会话正文衬线开关，
 * 按设备存，运行时注入，不重新 build。纯逻辑在 ./font-prefs-parse.ts，存储 / 首帧见 ./css-pref-store.ts。
 */
export const STYLE_ID = "cstra-font-prefs";
export const TEXT_KEY = "cstra_font_prefs";
export const CSS_KEY = "cstra_font_prefs_css";

const store = createCssPrefStore<FontPrefs>({
  textKey: TEXT_KEY,
  cssKey: CSS_KEY,
  styleId: STYLE_ID,
  empty: EMPTY_FONT_PREFS,
  normalize: normalizeFontPrefs,
  isEmpty: isEmptyFontPrefs,
  build: buildFontCss,
});

export const getFontPrefs = store.get;
export const setFontPrefs = store.set;
export const useFontPrefs = store.useValue;

export interface LocalFontsResult {
  families: string[];
  /** unsupported = 浏览器没有 Local Font Access API（Safari / iOS / Firefox，或非安全上下文） */
  status: "ok" | "unsupported" | "denied";
}

/** 能不能读本机字体：桌面 Chrome / Edge 且 HTTPS 或 localhost 才有这个 API。 */
export function localFontsSupported(): boolean {
  return typeof window !== "undefined" && "queryLocalFonts" in window;
}

/** 读本机字体族（必须在用户手势里调用，首次会弹权限）。按 family 去重、按名排序。 */
export async function readLocalFonts(): Promise<LocalFontsResult> {
  if (!localFontsSupported()) return { families: [], status: "unsupported" };
  try {
    const fonts = (await (window as unknown as { queryLocalFonts(): Promise<{ family: string }[]> }).queryLocalFonts()) ?? [];
    const families = Array.from(new Set(fonts.map((f) => f.family))).sort((a, b) => a.localeCompare(b));
    return { families, status: "ok" };
  } catch {
    return { families: [], status: "denied" }; // 用户拒绝授权或浏览器策略禁止：面板显示原因，不抛
  }
}
