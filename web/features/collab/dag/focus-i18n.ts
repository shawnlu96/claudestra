/**
 * 子 DAG 分区列表（FocusBoard，team-project-SUBDAG4）的局部词表，写法同 work/work-i18n.ts：中文原样，英文查这里，{x} 由 tr 填。
 * 后续卡（SUBDAG5 搜索 / 分天、SUBDAG7 聚焦图、SUBDAG8 手机）要用的词也一次写全，它们只 import 不改这个文件。
 * 不进共享字典 collab-i18n.ts：那边 UXTERM1 / UXI18N1 在动。步骤词取 web/lib/owner-words.ts 的 STEP_WORD，这里给英文。
 */
import type { I18nParams } from "@/lib/i18n-fill";
import type { Tr } from "../collab-model";
import { READY_WORD, STEP_WORD } from "@/lib/owner-words";

const WORDS: Record<string, string> = {
  "进行中 {n}": "In progress {n}", "接下来 {n}": "Up next {n}", "已完成 {n}": "Done {n}",
  "列表": "List", "图": "Graph", "版本": "Version", "待批": "Pending approval",
  "近 24 小时完成 {n}": "Done in last 24h {n}", "在干活 {n}": "Working {n}", "在等 {n}": "Waiting {n}", "没开始 {n}": "Not started {n}",
  "本机": "Local", "解锁 {n}": "Unlocks {n}", "第 {n} 轮": "Round {n}", "审查 {r} 轮 · 返工 {f} 轮": "{r} reviews · {f} reworks",
  [READY_WORD]: "Ready to start", [`${READY_WORD} {n}`]: "Ready to start {n}", "下一批 {n}": "Next batch {n}", "更远 {n}": "Further out {n}",
  "等 {x}": "Waits on {x}", "还差 {n} 层": "{n} levels away", "+{n}": "+{n}",
  "近 24 小时 {n}": "Last 24h {n}", "最近": "Latest", "第 {n} 轮通过": "Passed in round {n}", "已取消": "Cancelled",
  "上游全部完成": "All upstream done", "上游": "Upstream", "下游": "Downstream", "收起": "Collapse", "展开": "Expand",
  "刚刚": "just now", "{n} 分钟前": "{n}m ago", "{n} 小时前": "{n}h ago", "{n} 天前": "{n}d ago",
  "阶段": "Stage", "审查": "Review", "交付": "Delivery", "决定": "Decision", "提问": "Question", "答复": "Answer", "备注": "Note",
  "调度": "Scheduler", "部署": "Deploy", "验证": "Verify", "派活": "Dispatch", "事件": "Event",
  "常规 {d}": "Usual {d}",
  // 后续卡（SUBDAG5 / 7 / 8）用的词
  "搜索": "Search", "清除": "Clear", "没有匹配": "No matches", "今天": "Today", "昨天": "Yesterday", "更早": "Earlier", "时间未知": "Time unknown",
  "再显示 50": "Show 50 more", "其余 {n} 已完成": "{n} more done", "完整画布": "Full canvas", "还有 {n} 个已完成": "{n} more done",
};

/** 步骤键 → 英文（中文取 STEP_WORD） */
const STEP_EN: Record<string, string> = {
  restate: "Confirming scope", write: "Building", review: "Review", final_review: "Final review", fix: "Rework", merge: "Merge",
  deploy: "Deploy", publishing: "Publishing", verify: "Verify", ui_check: "UI check",
};

export type Ft = (s: string, p?: I18nParams) => string;

/** 中文界面原样过 tr（只填 {x}），英文先换成这里的说法再填 */
export function focusT(tr: Tr): Ft {
  const zh = tr("子 DAG") === "子 DAG";
  return (s, p) => tr(zh ? s : WORDS[s] ?? s, p);
}

/** 步骤键 → 给 owner 看的词（owner-words.ts）；不认识的键原样不出（返回 null） */
export function stepWordOf(key: string, ft: Ft): string | null {
  if (!Object.hasOwn(STEP_WORD, key)) return null;
  const zh = ft("列表") === "列表";
  return zh ? STEP_WORD[key]! : STEP_EN[key] ?? STEP_WORD[key]!;
}

/** 事件 kind → 类别词；不认识的写「事件」 */
const EVENT_WORD: Record<string, string> = {
  stage: "阶段", review: "审查", deliver: "交付", decision: "决定", ask: "提问", ask_cancel: "答复", note: "备注",
  scheduler: "调度", deploy: "部署", verify: "验证", dispatch: "派活",
};
export const eventWord = (kind: string, ft: Ft): string => ft(Object.hasOwn(EVENT_WORD, kind) ? EVENT_WORD[kind]! : "事件");

const MIN = 60_000;
/** 相对时间：一分钟内「刚刚」，其后分钟 / 小时 / 天 */
export function relTime(at: number, now: number, ft: Ft): string {
  const ms = Math.max(0, now - at);
  if (ms < MIN) return ft("刚刚");
  if (ms < 60 * MIN) return ft("{n} 分钟前", { n: Math.floor(ms / MIN) });
  if (ms < 24 * 60 * MIN) return ft("{n} 小时前", { n: Math.floor(ms / (60 * MIN)) });
  return ft("{n} 天前", { n: Math.floor(ms / (24 * 60 * MIN)) });
}
