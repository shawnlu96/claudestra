/**
 * 「今天」总览的局部词表（UXHOME1 / TODAY1）：只这一页用的词不进共享字典（写法同 collab/detail-now-i18n.ts）。
 * ZH 是给别处模板换说法用的：ledger-stage.ts reviewChipView 出的「在审 X · 第 N 轮」在这里写成「审 X 第 N 轮」。
 * 不 import lib/i18n.tsx（带 JSX，根目录 tsc 跑 tests/ 时进不来）；兜底的全局 t 由调用方传。
 */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";

type Translate = (s: string, params?: I18nParams) => string;

const ZH: Record<string, string> = {
  "在审 {id} · 第 {n} 轮": "审 {id} 第 {n} 轮",
};

const EN: Record<string, string> = {
  "今天": "Today",
  "{n} 个 agent 在干活": "{n} agent working|{n} agents working",
  "{n} 件要你处理": "{n} needs you|{n} need you",
  "没有要你处理的": "Nothing needs you",
  "要你处理": "Needs you",
  "去处理": "Handle",
  "看任务": "View task",
  "卡住了": "Stuck",
  "{n} 条": "{n} line|{n} lines",
  "还有 {n} 条": "{n} more",
  "收起": "Show less",
  "正在做": "In progress",
  "{n} 个在做": "{n} in progress",
  "其他": "Other",
  "其余 {n} 个项目": "{n} more project|{n} more projects",
  "现在没有 agent 在干活": "No agent is working right now",
  "还没有项目": "No projects yet",
  "今天完成": "Done today",
  "今天完成 {n} 个任务": "{n} task done today|{n} tasks done today",
  "有 {n} 个项目没有完成时间，未计入": "{n} project has no finish times and is not counted|{n} projects have no finish times and are not counted",
  "团队与额度": "Team & quota",
  "{n} 个 agent 活着 · {m} 个在干活": "{n} agents alive · {m} working",
  "{f} 本周 {n}%": "{f} {n}% this week",
  "整页": "Full page",
  "打开今天整页": "Open Today as a full page",
  "还有 {n} 件": "{n} more",
  "{n} 件": "{n} item|{n} items",
  "在干活 {n} 个 agent": "{n} agent working|{n} agents working",
  "待你处理 {n} 件": "{n} waiting on you",
  "团队": "Team",
  "展开今天总览": "Expand the Today overview",
  "收起今天总览": "Collapse the Today overview",
  "打开 {p} 的协作视图": "Open the collaboration view of {p}",
  "在审 {id} · 第 {n} 轮": "Reviewing {id} round {n}",
  "大总管": "Master",
};

export function nowTr(lang: "zh" | "en", base: Translate): Translate {
  return (s, p) => {
    const table = lang === "zh" ? ZH : EN;
    return Object.hasOwn(table, s) ? fillParams(table[s]!, p) : base(s, p);
  };
}
