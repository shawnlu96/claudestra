"use client";
/**
 * 今天完成：跨项目合计「今天完成 N 个任务」，默认收起，点开按项目列任务标题（每项目最多 5 条，多的「还有 K 条」）；点任务同「卡住了」。
 * 总览说不知道完成时间（unknownMetrics 含 todayDone）的项目不计入，块尾小字写明。N 为 0 时整块不出。
 */
import { useState } from "react";
import { Chevron } from "../chat/components/project-group";
import type { TodayView } from "./now-model";
import { Block, Fold, ROW_ON, useOpeners, type Translate } from "./now-ui";

export function NowDone({ view, tr }: { view: Pick<TodayView, "done" | "doneTotal" | "doneUnknown">; tr: Translate }) {
  const open = useOpeners();
  const [all, setAll] = useState(false);
  if (!view.doneTotal) return null;
  return (
    <Block title={tr("今天完成")} hook="done">
      <button type="button" className={`${ROW_ON} font-medium`} aria-expanded={all} data-now-done-toggle onClick={() => setAll((v) => !v)}>
        <span className="flex-1">{tr("今天完成 {n} 个任务", { n: view.doneTotal })}</span>
        <Chevron open={all} className="shrink-0 text-base-content/45" />
      </button>
      <Fold open={all}>
        <ul className="flex list-none flex-col gap-1 p-0 pt-1">
          {view.done.map((d) => (
            <li key={d.id} data-now-done-project={d.id}>
              <p className="px-2 pt-1 text-[11px] font-medium text-base-content/50">{d.name}</p>
              <ul className="flex list-none flex-col p-0">
                {d.tasks.map((x) => (
                  <li key={x.id}>
                    <button type="button" className={ROW_ON} data-now-done-task={x.id} onClick={() => open.task(d.id, x.id)}>
                      <span className="min-w-0 flex-1 truncate">{x.title}</span>
                    </button>
                  </li>
                ))}
                {d.more > 0 && <li className="px-2 py-1 text-[12px] text-base-content/50">{tr("还有 {n} 条", { n: d.more })}</li>}
              </ul>
            </li>
          ))}
        </ul>
      </Fold>
      {view.doneUnknown > 0 && <p className="px-2 pt-1 text-[11px] text-base-content/45" data-now-done-unknown>{tr("有 {n} 个项目没有完成时间，未计入", { n: view.doneUnknown })}</p>}
    </Block>
  );
}
