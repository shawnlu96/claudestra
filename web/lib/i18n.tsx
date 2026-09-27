"use client";
import { useEffect, useSyncExternalStore } from "react";
// 字典集中在 lib/i18n-dict.ts（纯数据，中文原文 → 英文）
import { DICT } from "./i18n-dict";
import { putSettings } from "./api/settings";

/**
 * 轻量 i18n（owner 2026-07-18「英文版 + 切换语言」）。
 *
 * 设计：中文原文即 key —— 组件里 t("新建会话") 自文档化，字典缺失回退中文，
 * 漏翻不炸界面。不引 next-intl/i18next：文案量 ~200 条，SSR 需求为零
 * （/chat 全 client 渲染），自制 30 行顶得住，符合本仓一贯的轻依赖风格。
 *
 * Hydration：module 初始固定 zh（与静态预渲染 HTML 一致），<I18nInit/> 在
 * mount 后读 localStorage / navigator.language 再切换（two-pass）——首帧
 * 中文一闪，/chat 有 Splash 盖着无感。
 *
 * 动态消息：store / 异步回调里照旧塞中文串，渲染点包 t() 兜底翻译——
 * 已知整串命中字典即翻，带变量的在生成处按 getLang() 分支。
 */

export type Lang = "zh" | "en";

let lang: Lang = "zh";
const subs = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang) {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem("cstra_lang", l);
  } catch {}
  try {
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  } catch {}
  syncLang(l);
  subs.forEach((f) => f());
}

/** 同步落盘当前机器（fire-and-forget）：bridge 生成的带变量文案（转写失败 / 拦截提示等）跟随此偏好 */
function syncLang(l: Lang) {
  void putSettings({ lang: l }).catch(() => {}); // 机器离线 / 还没配对：偏好本地已生效，下次切换再同步
}

/** mount 后初始化：显式选择 > 系统语言 > zh。不落盘（跟随系统的用户换系统语言要跟着变）。 */
function initLang() {
  let next: Lang | null = null;
  try {
    const saved = localStorage.getItem("cstra_lang");
    if (saved === "zh" || saved === "en") next = saved;
    else if (!navigator.language.toLowerCase().startsWith("zh")) next = "en";
  } catch {}
  if (next && next !== lang) {
    lang = next;
    try {
      document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    } catch {}
    subs.forEach((f) => f());
  }
  // 把实际生效的语言同步到当前机器(幂等)——「跟随系统」推断出 en 时,机器若还停在默认 zh,文案会跟界面错位。
  // 机器要等配置 + 清单就位（MachineGate）才有基址，这里晚一拍再发
  setTimeout(() => syncLang(lang), 3000);
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => lang,
    () => "zh"
  );
}

/** 纯函数翻译（store / 工具函数用）。组件渲染里用 useT() 保证切语言即时重渲。 */
export function t(s: string): string {
  if (lang === "zh") return s;
  return DICT[s] ?? s;
}

/** 指定语言翻译（不看全局语言）：导出文件的抬头等「界面之外」的文案按用户选的语言出。 */
export function tIn(l: Lang, s: string): string {
  if (l === "zh") return s;
  return DICT[s] ?? s;
}

/** 组件用：订阅语言变化 + 返回 t。 */
export function useT(): typeof t {
  useLang();
  return t;
}

/** 挂在 layout 里的初始化组件（two-pass 第二趟）。 */
export function I18nInit() {
  useEffect(() => {
    initLang();
    // 启动看门狗解除信号(layout.tsx 内联脚本):任何页面水合到这里 = 主 bundle
    // 已启动,25s 兜底提示不再弹
    (window as unknown as { __cstraMounted?: boolean }).__cstraMounted = true;
  }, []);
  return null;
}
