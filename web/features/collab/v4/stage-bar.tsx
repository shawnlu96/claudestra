"use client";
/** 阶段条：七列（与 v3 同一套 COLUMNS）走到哪一格；调查 / 运维不走的列画成空心。节点和手机卡片共用 */
import { COLUMNS, columnOf, skippedColumns, type Stage } from "../collab-model";
import v from "./v4.module.css";

export function StageBar({ stage, before, kind }: { stage: Stage; before?: Stage | null; kind: string }) {
  const at = columnOf(stage, before);
  const skip = new Set(skippedColumns(kind));
  const done = stage === "done" || stage === "verified";
  return (
    <span className={v.bar} aria-hidden>
      {COLUMNS.map((c, i) => (
        <span key={c} className={`${v.seg} ${skip.has(i) ? v.skip : i < at || done ? v.past : i === at ? v.cur : ""}`} />
      ))}
    </span>
  );
}
