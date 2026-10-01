"use client";
/** v4 左区大纲：固定的「待你处理 N」入口、筛选、事项 → 任务（状态点 + 阶段）。点任务 = 选中并让画布平移过去 */
import type { LedgerOverview, LineView, OwnerWait, Tr } from "../collab-model";
import { DoneMoreButton, useDonePages } from "../collab-done";
import { FILTER_LABEL, FILTERS, filterCount, outlineOf, type Filter } from "./v4-model";
import v from "./v4.module.css";

export function Outline(props: {
  project: string;
  ov: LedgerOverview;
  lines: ReadonlyMap<string, LineView>;
  filter: Filter;
  onFilter: (f: Filter) => void;
  waits: readonly OwnerWait[];
  onWaits: () => void;
  selected: string | null;
  onPick: (id: string) => void;
  tr: Tr;
}) {
  const { ov, lines, filter, tr } = props;
  const done = useDonePages(props.project, ov);
  // 「已完成」把翻到的更早的卡并进各事项组，底部「更多」接着翻（collab-done.tsx）
  const groups = outlineOf(filter === "done" ? { ...ov, tasks: [...ov.tasks, ...done.pages] } : ov, filter);
  return (
    <nav className={v.outline} aria-label={tr("大纲")}>
      <button type="button" className={`${v.waits} ${props.waits.length ? v.hasWaits : ""}`} onClick={props.onWaits}>
        {tr("待你处理")} <b>{props.waits.length}</b>
      </button>
      <div className={v.filters} role="tablist">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`${v.chip} ${filter === f ? v.chipOn : ""}`} onClick={() => props.onFilter(f)}>
            {tr(FILTER_LABEL[f])} <span className={v.cnt}>{filterCount(ov, f)}</span>
          </button>
        ))}
      </div>
      {groups.map((g) => (
        <div key={g.id ?? "loose"} className={v.og}>
          <div className={v.ogt}>{g.title || tr("未归事项")}</div>
          {g.tasks.map((t) => {
            const l = lines.get(t.id);
            return (
              <button key={t.id} type="button" className={`${v.ot} ${props.selected === t.id ? v.otSel : ""}`} onClick={() => props.onPick(t.id)}>
                <span className={`${v.dot} ${l ? v[l.tone] ?? "" : t.stage === "done" || t.stage === "verified" ? v.green : ""}`} />
                <span className={v.tid}>{t.id}</span>
                <span className={v.ott}>{t.title}</span>
                <span className={v.ost}>{l?.stageLabel ?? tr(t.stage === "done" ? "已完成" : t.stage)}</span>
              </button>
            );
          })}
        </div>
      ))}
      {groups.length === 0 && !(filter === "done" && done.more) && <div className={v.none}>{tr("这一栏是空的")}</div>}
      {filter === "done" && <DoneMoreButton d={done} tr={tr} />}
    </nav>
  );
}
