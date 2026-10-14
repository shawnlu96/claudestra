import { fillParams } from "@/lib/i18n-fill";
import type { Tr } from "./collab-model";

const EN: Record<string, string> = {
  "暂停调度": "Pause scheduling", "确认暂停": "Confirm pause", "继续": "Resume", "暂停理由": "Reason for pausing",
  "owner 在卡片详情暂停": "Owner paused from card details",
  "暂停后调度器不再给这张卡派新活，当前这一轮照常做完；继续后从原处接上":
    "Pausing stops new assignments for this card; the current turn finishes normally. Resume picks up where it left off",
  "已暂停": "Paused", "{who} {time} 暂停": "Paused by {who} {time}",
  "{d}前": "{d} ago", "刚刚": "just now",
  "你点继续后，调度器接着派": "Scheduling continues when you click Resume",
  "已耗额度": "Usage so far", "还没有用量记录": "No usage records yet",
  "{n} 万": "{n} × 10,000", "不到 1 万": "less than 10,000",
  "{family} 约 {tokens} token": "{family}: about {tokens} tokens",
  "约占本周额度 {n}%": "about {n}% of this week's quota", "约占本周额度不到 1%": "about less than 1% of this week's quota",
  "另有 {n} 单在其他成员机器上跑，用量对方没回传": "Another {n} orders ran on other members' machines; usage was not reported",
  "早于 {date} 的部分已不可查": "Some records before {date} are no longer available",
  "这张卡在 {m} 上执行，用量记在那台机器": "This card runs on {m}; usage is recorded on that machine",
};
export function detailPauseTr(tr: Tr, lang: "zh" | "en"): Tr {
  return (s, p) => lang !== "zh" && Object.hasOwn(EN, s) ? fillParams(EN[s]!, p) : tr(s, p);
}
