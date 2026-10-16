/**
 * 项目页四个标签与总览新句子的局部词表（写法同 dag/focus-i18n.ts）：中文原样过 tr，英文先换成这里的说法再填 {x}。
 * 「模块」= 产品看板里的 feature；界面上不出 feature / 子 DAG / 产品 DAG 这几个叫法。
 */
import { useMemo } from "react";
import { useLang } from "@/lib/i18n";
import type { Tr } from "../collab-model";

export const TAB_WORDS = { overview: "总览", map: "项目地图", module: "模块进度" } as const;

const WORDS: Record<string, string> = {
  [TAB_WORDS.overview]: "Overview", [TAB_WORDS.map]: "Project map", [TAB_WORDS.module]: "Module progress",
  "{n} 个在推进 · {k} 个卡住": "{n} in progress · {k} stuck", "{n} 个在推进 · 没有卡住的": "{n} in progress · none stuck",
  "合并队列冻结": "merge queue frozen", "今天完成": "Done today", "合并队列": "Merge queue", "审查中": "In review",
  "卡住了": "Stuck", "要你定的": "Needs your call", "没有要你定的": "Nothing needs your call", "已完成 {n}": "Done {n}",
  "按模块": "By module", "按人": "By person", "模块": "Modules",
  "{d}/{t} 完成": "{d}/{t} done", "项目": "Project",
  "另有 {k} 个模块还没读到，数字不含它们": "{k} more modules not loaded yet; numbers exclude them",
};

export function projectTabsT(tr: Tr, zh: boolean): Tr {
  return (s, p) => tr(zh ? s : WORDS[s] ?? s, p);
}

export function useProjectTabsT(tr: Tr): Tr {
  const lang = useLang();
  return useMemo(() => projectTabsT(tr, lang === "zh"), [tr, lang]);
}
