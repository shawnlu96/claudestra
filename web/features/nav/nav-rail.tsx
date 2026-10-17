"use client";
/**
 * 电脑竖向图标栏（NAVBAR1，只在 ≥640 渲染）：aside 内最左边 56px，今天 / 项目 / 会话 / 团队在上，「我的」贴底（点开菜单）。
 * 选中项主色加左侧指示条；aside 在 --cstra-rail-w 上让出左边距，原侧栏内容整体右移，不动 chat.tsx。
 */
import { NAV_ENTRIES } from "./nav-entries";
import { NavButton, type NavCounts } from "./nav-button";
import { MeMenu, type MeItem } from "./me-menu";
import { useNavT } from "./use-nav-t";
import { setTab, type NavTab } from "./nav-tab";

/** 图标栏宽度（px）：aside 总宽 = 用户拖的宽度 + 它，拖宽手柄换算时减掉 */
export const RAIL_W = 56;

export function NavRail({ tab, counts, items }: { tab: NavTab; counts: NavCounts; items: MeItem[] }) {
  const tr = useNavT();
  return (
    <nav aria-label={tr("主导航")} data-nav="rail" className="absolute inset-y-0 left-0 z-20 flex flex-col gap-1 border-r border-base-300 bg-base-200 px-1 pb-2"
      style={{ width: RAIL_W, paddingTop: "calc(var(--cstra-quota-pane-safe-top, env(safe-area-inset-top)) + 0.5rem)" }}>
      {NAV_ENTRIES.filter((e) => e.rail).map((e) => (
        <div key={e.tab} className="relative">
          {e.tab === tab && <span aria-hidden className="absolute -left-1 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" data-nav-indicator />}
          <NavButton e={e} on={e.tab === tab} counts={counts} onClick={() => setTab(e.tab)} className="h-14 w-full rounded-lg hover:bg-base-300/50" />
        </div>
      ))}
      <div className="mt-auto"><MeMenu items={items} /></div>
    </nav>
  );
}
