/**
 * 概览「其中 N 条出问题 / 卡住」点开的那一页（attention-page.tsx）要列的行：纯函数，不 import react。
 * 行直接从 homeView(...).lines 里按 attention 取，不另算口径，所以不带 active 时行数 = headline.problem / stuck；
 * 带上 active（count-words.ts CountSnap.active）时和右栏「现在」那句的数（count-words.ts attentionOf）同一口径。
 * 单测 tests/web-collab-attention-list.test.ts。
 */
import { fmtDuration, type LineView, type Tr } from "../collab-model";

export type AttentionWhich = "problem" | "stuck";
export type AttentionRow = Pick<LineView, "id" | "title" | "stageLabel" | "reason" | "dwellMs" | "dwellApprox">;

/** 停得久的在前（没有时长的排最后），同长按 id 兜底 */
export function attentionRows(lines: readonly LineView[], which: AttentionWhich, active?: ReadonlySet<string> | null): AttentionRow[] {
  return lines
    .filter((l) => l.attention === which && (!active || active.has(l.id)))
    .sort((a, b) => (b.dwellMs ?? -1) - (a.dwellMs ?? -1) || a.id.localeCompare(b.id))
    .map(({ id, title, stageLabel, reason, dwellMs, dwellApprox }) => ({ id, title, stageLabel, reason, dwellMs, dwellApprox }));
}

/** 行的第二行：阶段短语 · 原因 · 停留时长；时长是导入推断的前面加 ≈（同 lineOf / dwellText），空的段不出 */
export function attentionMeta(r: AttentionRow, tr: Tr): string {
  const dwell = r.dwellMs === null ? "" : `${r.dwellApprox ? "≈" : ""}${fmtDuration(r.dwellMs, tr)}`;
  return [r.stageLabel, r.reason, dwell].filter(Boolean).join(" · ");
}
