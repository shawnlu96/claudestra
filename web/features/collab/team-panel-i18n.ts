"use client";
import { useLang } from "@/lib/i18n";

const WORDS: Record<string, string> = {
  "你": "You", "大总管": "Coordinator", "成员": "Members", "派活": "Assigned", "派审": "Review requested", "交付": "Delivered",
  "审查员": "Reviewer", "执行者": "Executor",
  "审查结论": "Review", "消息": "Message", "最近往来": "Recent interactions", "收件人未知": "Recipient unknown", "打开会话": "Open chat",
  "最近 10 分钟 · 只显示已记录的真实往来": "Last 10 minutes · recorded interactions only",
  "最近 10 分钟没有可确认的往来": "No confirmed interactions in the last 10 minutes",
  "仅显示最新记录，未列全": "Showing the latest records; list is incomplete",
  "缺少收件人的交付和审查只列记录，不推测连线。外部 PM、模型、额度未提供时为未知。":
    "Deliveries and reviews without recipients are listed, not connected. Missing peer PM, model and quota remain unknown.",
  "团队": "Team", "本机": "Local", "外部实例": "Peers", "未知": "Unknown", "空闲": "Idle", "忙": "Busy",
  "已停止": "Stopped", "在线": "Online", "离线": "Offline", "上下文": "Context", "项目": "Project",
  "能接": "Available", "不接": "Unavailable", "额度": "Quota", "暂无成员": "No members", "暂无外部实例": "No peers",
  "数据源不可用": "Source unavailable", "本项目的卡": "Cards in this project", "暂无关联卡": "No linked cards",
  "仅显示对方开放的成员；未提供的信息显示未知。": "Only shared members are visible; missing information is unknown.",
  "额度档位仅按本机缓存估算，不代表接单承诺。": "Quota tiers are estimates from the local cache, not acceptance promises.",
};

export function useTeamT() {
  const lang = useLang();
  return (text: string) => lang === "zh" ? text : WORDS[text] ?? text;
}
