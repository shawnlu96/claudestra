"use client";
import { useLang } from "@/lib/i18n";
import { LEND_WORDS as L, ownerWordEn } from "@/lib/owner-words";

/** 词表里的词（lib/owner-words）：键和 en 值都从那里取 */
const en = (zh: string) => ownerWordEn(zh) ?? zh;

/** 额度提醒条的文案（中文原文 → 英文），{x} 是变量；时间按浏览器本地时区、跟随界面语言 */
const WORDS: Record<string, string> = {
  [L.warnTitleStop]: en(L.warnTitleStop),
  "{family} 本周已用 {pct}%，达到提醒线": "{family} used {pct}% this week — warn line reached",
  [L.statusStopped]: en(L.statusStopped),
  [L.statusObserveStop]: en(L.statusObserveStop),
  [L.statusHalved]: en(L.statusHalved),
  [L.statusObserveWarn]: en(L.statusObserveWarn),
  "重置 {when}": "Resets {when}", "重置时间未知": "Reset time unknown", "上次读数": "Last known reading",
  "关闭": "Dismiss", "出借额度提醒": "Lending quota warning",
};

export function useWarnT() {
  const lang = useLang();
  const t = (text: string, vars: Record<string, string | number> = {}) =>
    (lang === "zh" ? text : WORDS[text] ?? text).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  const when = (ms: number) => new Date(ms).toLocaleString(lang === "zh" ? "zh-CN" : "en", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return { t, when };
}
