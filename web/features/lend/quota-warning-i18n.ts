"use client";
import { useLang } from "@/lib/i18n";

/** 额度提醒条的文案（中文原文 → 英文），{x} 是变量；时间按浏览器本地时区、跟随界面语言 */
const WORDS: Record<string, string> = {
  "{family} 本周已用 {pct}%，达到停接线": "{family} used {pct}% this week — stop line reached",
  "{family} 本周已用 {pct}%，达到提醒线": "{family} used {pct}% this week — warn line reached",
  "已停止接新单，在跑的单照常做完": "Not accepting new orders; running orders continue",
  "只观察：未停接，仍在接新单": "Observe only: still accepting new orders",
  "未停接，新单名额已减半": "Still accepting; new-order slots halved",
  "只观察：未停接，名额未缩减": "Observe only: still accepting, slots unchanged",
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
