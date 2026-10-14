/** 四个状态词与计数提示的局部词表（UXNUM1）：短词不进共享字典，免得改掉别处同字不同义的译文（同 work/work-i18n.ts 的做法） */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";
import type { Tr } from "./collab-model";

const WORDS: Record<string, string> = {
  "在干活": "Working", "在等": "Waiting", "没开工": "Not started", "已完成": "Done", "进行中": "In progress", "全部": "All",
  "周额度": "Weekly quota",
  "其中 {n} 条出问题": "{n} with problems", "{n} 条卡住": "{n} stuck",
  "另有 {k} 个 feature 还没读到，数字不含它们": "{k} more features not loaded yet; numbers exclude them",
};

/** 中文界面原样（带参数填好）；其他语言查本表，查不到退回调用方的 tr */
export function countText(tr: Tr, word: string, params?: I18nParams): string {
  if (tr("子 DAG") === "子 DAG") return fillParams(word, params);
  const en = WORDS[word];
  return en ? fillParams(en, params) : tr(word, params);
}
