/**
 * 五个入口与「我的」的局部词表（NAVBAR1，写法同 now/now-i18n.ts）：只这一层用的词不进共享字典。
 * 不 import lib/i18n.tsx（带 JSX，根目录 tsc 跑 tests/ 时进不来）；表里没有的交给调用方传的全局 t（设置、用量看板等原有词条在那边）。
 */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";

type Translate = (s: string, params?: I18nParams) => string;

const EN: Record<string, string> = {
  "今天": "Today",
  "项目": "Projects",
  "会话": "Sessions",
  "团队": "Team",
  "我的": "Me",
  "主导航": "Main navigation",
  "伙伴机器": "Partner machines",
  "{n}/{total} 在线": "{n}/{total} online",
  "{n} 件要你处理": "{n} needs you|{n} need you",
  "{n} 条未读": "{n} unread",
  "成员与位子": "Members and seats",
  "规划与提案": "Planning and proposals",
  "还没有团队项目，加入后会出现在这里": "No team projects yet. They show up here once you join one.",
  "本机还没有绑定团队的项目": "No project on this machine is bound to a team yet",
};

export function navTr(lang: "zh" | "en", base: Translate): Translate {
  return (s, p) => (lang === "en" && Object.hasOwn(EN, s) ? fillParams(EN[s]!, p) : base(s, p));
}
