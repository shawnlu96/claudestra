/**
 * 「现在」总览的局部词表（UXHOME1）：只这一页用的词不进共享字典（写法同 collab/detail-now-i18n.ts）。
 * ZH 是给别处模板换说法用的：ledger-stage.ts reviewChipView 出的「在审 X · 第 N 轮」在这里写成「审 X 第 N 轮」。
 * 不 import lib/i18n.tsx（带 JSX，根目录 tsc 跑 tests/ 时进不来）；兜底的全局 t 由调用方传。
 */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";

type Translate = (s: string, params?: I18nParams) => string;

const ZH: Record<string, string> = {
  "在审 {id} · 第 {n} 轮": "审 {id} 第 {n} 轮",
};

const EN: Record<string, string> = {
  "现在": "Now",
  "{n} 个 agent 在干活": "{n} agent working|{n} agents working",
  "{n} 件等你": "{n} waiting on you",
  "等你的事": "Waiting on you",
  "在干活": "Working now",
  "各项目": "Projects",
  "没有等你的事": "Nothing is waiting on you",
  "现在没有 agent 在干活": "No agent is working right now",
  "还没有项目": "No projects yet",
  "还有 {n} 件": "{n} more",
  "来自 {p}": "from {p}",
  "{n} 个 agent": "{n} agent|{n} agents",
  "{n} 件": "{n} item|{n} items",
  "在干活 {n} 个 agent": "{n} agent working|{n} agents working",
  "待你处理 {n} 件": "{n} waiting on you",
  "展开全部（共 {n} 个）": "Show all {n}",
  "收起": "Show less",
  "团队": "Team",
  "展开现在总览": "Expand the Now overview",
  "收起现在总览": "Collapse the Now overview",
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
