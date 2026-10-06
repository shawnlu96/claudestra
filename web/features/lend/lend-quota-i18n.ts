"use client";
import { useLang } from "@/lib/i18n";

const WORDS: Record<string, string> = {
  "额度线": "Quota lines", "本周已用": "Used this week", "提醒线": "Warn at", "停接线": "Stop at", "保存": "Save", "未知": "Unknown",
  "用量未知": "Usage unknown", "已停接": "Not accepting", "超过停接线（未执行）": "Over stop line (not enforced)", "提醒": "Warning",
  "提醒 · 已缩减": "Warning · reduced", "正常": "Normal", "重置": "Resets", "上次读数": "Last known", "可接": "Slots",
  "执行": "Enforce", "只观察": "Observe", "关闭": "Off", "加载失败": "Failed to load", "保存失败": "Save failed", "已保存": "Saved",
  "要是 0 到 100 的整数": "Must be an integer 0–100", "提醒线要低于停接线": "Warn line must be below stop line",
  "配置文件损坏，正按默认 70/80 执行；保存一次即修复": "Config file is corrupt; defaults 70/80 apply. Save once to repair",
  "本机该家族本周用量达到停接线后不再接新单，在跑的单不受影响": "At the stop line this family takes no new orders; running orders continue",
  "提醒区间的缩减比例尚待批准，目前只提示": "Reduction in the warn zone is pending approval; warning only for now",
};

export function useQuotaT() {
  const lang = useLang();
  return (text: string) => (lang === "zh" ? text : WORDS[text] ?? text);
}
