"use client";
import { useLang } from "@/lib/i18n";

/** Words of the team entry (sidebar avatar stack) and the standalone team page; roster words stay in roster-i18n.ts. */
const WORDS: Record<string, string> = {
  "团队": "Team", "团队成员": "Team members", "返回": "Back", "人": "members", "项目": "Project",
  "在协作视图打开": "Open in collaboration view", "这个团队还没有绑定本机项目": "This team has no project bound on this machine",
  "打开团队页": "Open team page",
};

export function useEntryT() {
  const lang = useLang();
  return (text: string) => lang === "zh" ? text : WORDS[text] ?? text;
}
