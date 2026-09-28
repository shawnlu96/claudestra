"use client";
/**
 * 协作视图的翻译入口：短词（阶段名、「在管」「实时」这类 ≤4 字的词）只在本模块的表里，不进全局字典——
 * 短词做全局 key 会改掉别处同字不同义的译文（tests/web-ledger-stage.test.ts 守着「开发」「验证」这几个）。
 * 整句模板照常在 lib/i18n-dict-collab.ts（经 DICT 全局可用）。组件一律用 useCollabT()。
 */
import { useMemo } from "react";
import { useLang } from "@/lib/i18n";
import { DICT } from "@/lib/i18n-dict";
import { fillParams } from "@/lib/i18n-fill";
import type { Tr } from "./collab-model";

const COLLAB_WORDS: Record<string, string> = {
  "协作视图": "Team view",
  "开发中": "Building",
  "你": "You",
  "PM": "PM",
  "上线": "Live",
  "今日完成": "Done today",
  "参与者": "People",
  "受阻": "Blocked",
  "合并": "Merge",
  "在审": "in review",
  "在管": "managing",
  "复述": "Restate",
  "实时": "live",
  "审查": "Review",
  "审查员": "Reviewer",
  "对它说": "Tell it",
  "导入": "import",
  "已冻结": "frozen",
  "已取消": "Cancelled",
  "已完成": "Done",
  "开发": "Build",
  "执行者": "Executor",
  "拦下": "blocked",
  "排队": "queued",
  "昨天": "Yesterday",
  "未派人": "unassigned",
  "现在": "Now",
  "空闲": "Idle",
  "等待": "Waiting",
  "要改": "changes",
  "规格": "Spec",
  "调度": "dispatch",
  "运行工具": "Running",
  "返工": "Fix",
  "通过": "pass",
  "重连中": "reconnecting",
  "验证": "Verify",
  "等开工": "Awaiting start",
};

export function useCollabT(): Tr {
  const lang = useLang();
  return useMemo<Tr>(() => (s, p) => fillParams(lang === "zh" ? s : (COLLAB_WORDS[s] ?? DICT[s] ?? s), p), [lang]);
}
