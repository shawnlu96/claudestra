/**
 * 团队会话查看器（TEAMVIS8）的英文：只在团队卡详情的「会话」区用，叠在传进来的 tr 之上（本表没有的词照旧走协作视图词表 / 全局字典）。
 * 和 team-body-i18n.ts 同一个做法：这几句只有这里用，不进协作视图的短词表。
 */
import { fillParams } from "@/lib/i18n-fill";
import type { Lang } from "@/lib/i18n";
import type { Tr } from "../collab-model";

const EN: Record<string, string> = {
  "会话": "Sessions",
  "作者 / 审查员会话": "Author / reviewer sessions",
  "按页向主场机器读取，只读": "Read page by page from the home machine, read-only",
  "查看会话": "View sessions",
  "收起会话": "Hide sessions",
  "正在向主场机器读取会话…": "Reading the session from the home machine…",
  "主场离线，暂时看不了会话": "The home machine is offline, sessions cannot be viewed right now",
  "主场未开放会话": "The home machine has not opened sessions",
  "你不在该项目成员里": "You are not a member of this project",
  "请求已过期": "The request expired",
  "主场拒绝提供这张卡的会话": "The home machine declined to send this card's sessions",
  "中心暂未开放会话": "Sessions are not available on the center yet",
  "会话暂时读不到": "Sessions are temporarily unavailable",
  "这张卡还没有会话内容": "This card has no session content yet",
  "重新获取": "Fetch again",
  "更早的消息": "Earlier messages",
  "会话 {n}": "Session {n}",
  "{n} 条消息": "{n} messages",
  "用户": "User",
  "助手": "Assistant",
  "工具输出": "Tool output",
  "已遮蔽 {n} 段": "{n} segments masked",
  "{n} 步工具调用": "{n} tool calls",
  "展开全部": "Show all",
  "收起列表": "Collapse",
};

export function teamSessionTr(tr: Tr, lang: Lang): Tr {
  return (s, p) => (lang !== "zh" && Object.hasOwn(EN, s) ? fillParams(EN[s]!, p) : tr(s, p));
}
