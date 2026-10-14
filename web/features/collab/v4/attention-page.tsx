"use client";
/**
 * 概览「其中 N 条出问题 / 卡住」点开的右栏页（team-project-UXPROB1）：列出是哪几个任务、各自的阶段、原因和停留时长，点一行进任务详情。
 * 行从当前 lines 里取（attention-list.ts），数据刷新后这一类清零了就写「现在没有」，不关页。
 */
import type { LineView, Tr } from "../collab-model";
import { Icon } from "../collab-icons";
import { fillParams, type I18nParams } from "@/lib/i18n-fill";
import { Shell } from "./v4-props";
import { attentionMeta, attentionRows, type AttentionWhich } from "./attention-list";
import v from "./v4.module.css";

/** 本页词条的局部表（同 work/work-i18n.ts 的做法）：不进共享字典 */
const WORDS: Record<string, string> = {
  "出问题": "Problems", "卡住": "Stuck", "点一个任务看详情": "Pick a task to see its details", "现在没有": "None right now",
  "查看出问题的 {n} 个任务": "View {n} tasks with problems", "查看卡住的 {n} 个任务": "View {n} stuck tasks",
};
export function attentionText(tr: Tr, word: string, params?: I18nParams): string {
  if (tr("子 DAG") === "子 DAG") return fillParams(word, params);
  const en = WORDS[word];
  return en ? fillParams(en, params) : tr(word, params);
}

/** 概览里那个数字按钮的 aria-label */
export const attentionAria = (tr: Tr, which: AttentionWhich, n: number) =>
  attentionText(tr, which === "problem" ? "查看出问题的 {n} 个任务" : "查看卡住的 {n} 个任务", { n });

export function AttentionPage({ which, lines, active, onPick, onClose, tr }: {
  which: AttentionWhich; lines: readonly LineView[]; active?: ReadonlySet<string> | null; onPick: (id: string) => void; onClose: () => void; tr: Tr;
}) {
  const rows = attentionRows(lines, which, active);
  return (
    <Shell title={attentionText(tr, which === "problem" ? "出问题" : "卡住")} sub={attentionText(tr, "点一个任务看详情")} onClose={onClose} tr={tr}>
      {rows.length ? rows.map((r) => (
        <div key={r.id} className={v.row} data-attention-row={r.id}>
          <button type="button" className={v.link} onClick={() => onPick(r.id)}>
            <span className={v.tid}>{r.id}</span> {r.title}
          </button>
          <div className={v.muted}>
            <Icon name={which === "problem" ? "circleAlert" : "clock"} size={12} /> <span className={which === "problem" ? v.bad : v.warn}>{attentionMeta(r, tr)}</span>
          </div>
        </div>
      )) : <div className={v.muted}>{attentionText(tr, "现在没有")}</div>}
    </Shell>
  );
}
