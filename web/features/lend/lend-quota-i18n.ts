"use client";
import { useLang } from "@/lib/i18n";
import { LEND_WORDS as L, ownerWordEn } from "@/lib/owner-words";

/** 词表里的词（lib/owner-words）：键和 en 值都从那里取 */
const en = (zh: string) => ownerWordEn(zh) ?? zh;

const WORDS: Record<string, string> = {
  "额度线": "Quota lines", "本周已用": "Used this week", "提醒线": "Warn at", [L.stopLine]: en(L.stopLine), "保存": "Save", "未知": "Unknown",
  "用量未知": "Usage unknown", [L.stopped]: en(L.stopped), [L.overStopLine]: en(L.overStopLine), "提醒": "Warning",
  "提醒 · 已缩减": "Warning · reduced", "正常": "Normal", "重置": "Resets", "上次读数": "Last known", "可接": "Slots",
  "执行": "Enforce", "只观察": "Observe", "关闭": "Off", "加载失败": "Failed to load", "保存失败": "Save failed", "已保存": "Saved",
  "要是 0 到 100 的整数": "Must be an integer 0–100", [L.warnBelowStop]: en(L.warnBelowStop),
  "配置文件读不了或不是合法 JSON，正按默认 70/80 执行；保存一次即修复": "Config file is unreadable or not valid JSON; defaults 70/80 apply. Save once to repair",
  "配置文件内容不合法，正按默认 70/80 执行；保存一次即修复": "Config file content is invalid; defaults 70/80 apply. Save once to repair",
  "原配置文件损坏，已另存备份后按这次保存的内容重写": "The corrupt config file was backed up and rewritten with this save",
  "额度线配置正被别的请求修改，稍后再试": "Quota lines are being changed by another request; try again",
  "保存额度线配置失败，没有生效（详情见本机日志）": "Saving quota lines failed and did not take effect (see local log)",
  [L.stopLineNote]: en(L.stopLineNote),
  [L.warnLineNote]: en(L.warnLineNote),
};

export function useQuotaT() {
  const lang = useLang();
  return (text: string) => (lang === "zh" ? text : WORDS[text] ?? text);
}
