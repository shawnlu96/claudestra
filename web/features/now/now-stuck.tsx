"use client";
/**
 * 卡住了：各项目 homeView 里 attention 为 problem / stuck 的线，problem 在前、再按停留时长倒序（todayView 排好），最多 8 条，
 * 多的收成「还有 K 条」就地展开。每行：任务标题 · 项目名 · 一句原因 · 停留时长（stuckRow）。没有卡住的整块不出。
 */
import { useState } from "react";
import { Icon } from "../collab/collab-icons";
import type { StuckRow, TodayView } from "./now-model";
import { Block, Fold, ROW_ON, useOpeners, type Translate } from "./now-ui";

function Row({ r, onOpen }: { r: StuckRow; onOpen: (r: StuckRow) => void }) {
  return (
    <li className="animate-[overlay-in_150ms_ease-out] motion-reduce:animate-none">
      <button type="button" className={`${ROW_ON} items-start`} data-now-stuck-row={`${r.project}/${r.id}`} onClick={() => onOpen(r)}>
        <Icon name={r.problem ? "circleAlert" : "hourglass"} size={14} className={`mt-0.5 shrink-0 ${r.problem ? "text-error" : "text-warning"}`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-medium">{r.title}</span>
            <span className="shrink-0 text-[11px] text-base-content/50">{r.projectName}</span>
          </span>
          {r.reason && <span className="truncate text-[12px] text-base-content/60" data-now-stuck-reason>{r.reason}</span>}
        </span>
        {r.dwell && <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-base-content/50" data-now-stuck-dwell>{r.dwell}</span>}
      </button>
    </li>
  );
}

export function NowStuck({ view, tr }: { view: Pick<TodayView, "stuck" | "stuckMore">; tr: Translate }) {
  const open = useOpeners();
  const [all, setAll] = useState(false);
  const total = view.stuck.length + view.stuckMore.length;
  if (!total) return null;
  const go = (r: StuckRow) => open.task(r.project, r.id);
  return (
    <Block title={tr("卡住了")} count={tr("{n} 条", { n: total })} hook="stuck">
      <ul className="flex list-none flex-col p-0">
        {view.stuck.map((r) => <Row key={`${r.project}/${r.id}`} r={r} onOpen={go} />)}
      </ul>
      {view.stuckMore.length > 0 && (
        <>
          <Fold open={all}>
            <ul className="flex list-none flex-col p-0">
              {view.stuckMore.map((r) => <Row key={`${r.project}/${r.id}`} r={r} onOpen={go} />)}
            </ul>
          </Fold>
          <button type="button" className={`${ROW_ON} text-base-content/60`} aria-expanded={all} data-now-stuck-more onClick={() => setAll((v) => !v)}>
            {all ? tr("收起") : tr("还有 {n} 条", { n: view.stuckMore.length })}
          </button>
        </>
      )}
    </Block>
  );
}
