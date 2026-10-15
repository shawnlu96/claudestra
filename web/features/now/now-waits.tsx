"use client";
/**
 * 要你处理（UXHOME1「等你的事」改名）：useAsks + waitsOnOwner（UXINBOX1 口径），按创建时间倒序最多 5 条，多的收成「还有 K 件」。
 * 每行两行字：上行标题，下行「项目 · 模块 · 任务标题」；整行即「去处理」（asksStore.openDrawer，同 v4-props.tsx WaitGo），
 * 有任务号的多一个「看任务」。作答留在收件箱抽屉（冷却、防重、guard 都在 asks-store），这里不复制。
 */
import { asksStore } from "../asks/asks-store";
import { Icon } from "../collab/collab-icons";
import type { TodayView } from "./now-model";
import { Block, EMPTY, ROW_ON, useOpeners, type Translate } from "./now-ui";

export function NowWaits({ view, tr }: { view: Pick<TodayView, "waits" | "waitTotal">; tr: Translate }) {
  const open = useOpeners();
  const more = view.waitTotal - view.waits.length;
  return (
    <Block title={tr("要你处理")} count={view.waitTotal ? tr("{n} 件", { n: view.waitTotal }) : undefined} hook="waits">
      {view.waits.length === 0 ? <p className={EMPTY} data-now-waits-empty>{tr("没有要你处理的")}</p> : (
        <ul className="flex list-none flex-col p-0">
          {view.waits.map((w) => (
            <li key={w.id} className="flex min-w-0 items-center gap-1">
              <button type="button" className={`${ROW_ON} items-start`} data-now-wait={w.id} onClick={() => asksStore.openDrawer(w.id)}>
                <Icon name="circleHelp" size={14} className="mt-0.5 shrink-0 text-warning" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{w.title}</span>
                  <span className="truncate text-[11px] text-base-content/50" data-now-wait-where>{w.where}</span>
                </span>
                <span className="mt-0.5 shrink-0 text-[12px] font-medium text-primary" data-now-wait-go>{tr("去处理")}</span>
              </button>
              {w.taskId && (
                <button type="button" className="shrink-0 rounded-lg px-2 py-1.5 text-[12px] text-base-content/60 transition-colors hover:bg-base-300/50"
                  data-now-wait-task={w.taskId} onClick={() => open.task(w.project, w.taskId!)}>
                  {tr("看任务")}
                </button>
              )}
            </li>
          ))}
          {more > 0 && (
            <li>
              <button type="button" className={`${ROW_ON} text-base-content/60`} data-now-wait-more onClick={() => asksStore.openDrawer()}>
                <span className="flex-1">{tr("还有 {n} 件", { n: more })}</span>
                <Icon name="chevronRight" size={13} className="shrink-0" />
              </button>
            </li>
          )}
        </ul>
      )}
    </Block>
  );
}
