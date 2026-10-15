"use client";
import { useLang } from "@/lib/i18n";
const WORDS: Record<string, string> = {
  "成员": "Members", "往来": "Interactions", "规划与提案": "Planning and proposals", "成员与位子": "Members and seats",
  "机器在线": "Machines online", "Claude 在用 / 总": "Claude used / total", "Codex 在用 / 总": "Codex used / total",
  "在写/修": "Writing / fixing", "在审": "Reviewing", "等合并": "Awaiting merge", "今天交付": "Delivered today", "暂无": "Unavailable",
  "未知": "Unknown", "本机": "Local", "你": "You", "团队 owner": "Team owner", "团队成员": "Team member",
  "未认领的机器": "Unclaimed machines", "机器尚未归属成员": "Machines without a member binding", "正在做": "Working on", "已上线待验": "Live, awaiting verification", "被挡": "Blocked",
  "交付": "Delivered", "审完": "Reviewed", "今天": "Today", "另有": "More", "个": "items", "在线": "Online", "离线": "Offline",
  "心跳": "Heartbeat", "秒前": "seconds ago", "轮": "Round", "分钟": "minutes", "在跑/总数": "Running / total",
  "这台设备读不到位子": "This device cannot read seats", "没有本机项目": "No local project",
  "没有借入他的机器": "No borrowed machines from this member", "没有团队目录，按机器显示": "No team directory; grouped by machine",
  "没有名册数据": "Roster unavailable", "没有团队目录": "Team directory unavailable", "部分机器读不到": "Some machines could not be read",
  "正在读取团队目录": "Loading team directory", "团队目录读取失败": "Team directory could not be read", "正在读取位子": "Loading seats", "读取中": "Loading", "暂无进行中的卡": "No active cards",
  "在用": "Running", "心跳停": "Silent", "待开工": "Pending", "其他项目": "Other project", "额度到线": "Quota held", "空闲": "Empty",
  "roster.slot.unreadable": "This device cannot read seats", "roster.slot.noMachines": "No borrowed machines from this member",
};
const ZH_KEYS: Record<string, string> = { "roster.slot.unreadable": "这台设备读不到位子", "roster.slot.noMachines": "没有借入他的机器" };
export function useRosterT() {
  const lang = useLang();
  return (text: string) => lang === "zh" ? (ZH_KEYS[text] ?? text)
    : WORDS[text] ?? text;
}
/** Never let instance IDs, hashes or UUIDs become display names, task labels or tooltip text. */
export function rosterText(text: string | null | undefined, fallback: string): string {
  return !text || /[0-9a-f]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(text) ? fallback : text;
}
