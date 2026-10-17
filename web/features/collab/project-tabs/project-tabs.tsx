"use client";
/**
 * 项目页的四个标签（总览 / 项目地图 / 模块进度 / 团队），桌面手机同一套，放在页头下面；只挂选中那一块。
 * 桌面一排文字标签不截断，选中下划线平移（transform 200ms）；手机一排可横滑的分段。标签状态在 dag/use-dag-ui.ts。
 * 各块内容由调用方给：map 插槽给 project-map-* 卡以后整块换。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Tr } from "../collab-model";
import { useTeamTab } from "../collab-page-head";
import type { DagTab } from "../dag/use-dag-ui";
import { TAB_WORDS, useProjectTabsT } from "./project-tabs-i18n";
import p from "./project-tabs.module.css";

export const TABS: readonly DagTab[] = ["overview", "map", "module", "team"];

/** 选中下划线的位置：跟着选中按钮的 offsetLeft / 宽度走；没量到之前不画 */
function useBar(tab: DagTab, on: boolean) {
  const refs = useRef(new Map<DagTab, HTMLButtonElement>());
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = on ? refs.current.get(tab) : undefined;
    if (!el) return;
    const measure = () => setBar((b) => (b && b.x === el.offsetLeft && b.w === el.offsetWidth ? b : { x: el.offsetLeft, w: el.offsetWidth }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, on]);
  return { refs, bar };
}

export function ProjectTabs(props: { tab: DagTab; setTab: (t: DagTab) => void; narrow: boolean; tr: Tr; panes: Record<DagTab, ReactNode> }) {
  const { tab, narrow } = props;
  const tr = useProjectTabsT(props.tr);
  const team = useTeamTab(props.tr).label;
  const { refs, bar } = useBar(tab, !narrow);
  const label = (k: DagTab) => (k === "team" ? team : tr(TAB_WORDS[k]));
  return (
    <div className={p.root}>
      <div className={narrow ? p.segs : p.tabs} role="tablist" aria-label={tr("项目")}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-project-tab={k}
            ref={(el) => { if (el) refs.current.set(k, el); else refs.current.delete(k); }}
            className={narrow ? `${p.segTab} ${tab === k ? p.segTabOn : ""}` : `${p.tab} ${tab === k ? p.tabOn : ""}`}
            onClick={() => props.setTab(k)}>{label(k)}</button>
        ))}
        {!narrow && bar && <span className={p.bar} aria-hidden style={{ width: bar.w, transform: `translateX(${bar.x}px)` }} />}
      </div>
      <div className={p.body} data-project-pane={tab}>{props.panes[tab]}</div>
    </div>
  );
}
