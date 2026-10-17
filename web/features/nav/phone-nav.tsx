"use client";
/**
 * 手机底部栏（NAVBAR1，只在 <640 渲染）：五格等宽，高 56px 再加 home 条安全区；选中项主色，底下一条指示条随选中项平移（200ms）。
 * absolute 贴在 aside 底部而不是 fixed：横滑到会话内容时父级带 transform，fixed 会跟着错位；贴在 aside 里正好跟列表页一起滑走。
 */
import { NAV_ENTRIES } from "./nav-entries";
import { NavButton, type NavCounts } from "./nav-button";
import { setTab, type NavTab } from "./nav-tab";
import { useNavT } from "./use-nav-t";

/** aside 底部留给底部栏的高度（PhoneTabs 设到 aside 的 --cstra-phone-nav-h 上，列表和页面层按它让位） */
export const PHONE_NAV_H = "calc(3.5rem + env(safe-area-inset-bottom))";

export function PhoneNav({ tab, counts }: { tab: NavTab; counts: NavCounts }) {
  const tr = useNavT();
  const at = Math.max(0, NAV_ENTRIES.findIndex((e) => e.tab === tab));
  return (
    <nav aria-label={tr("主导航")} data-nav="phone" className="absolute inset-x-0 bottom-0 z-20 border-t border-base-300 bg-base-200"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="relative grid h-14 grid-cols-5">
        {NAV_ENTRIES.map((e) => <NavButton key={e.tab} e={e} on={e.tab === tab} counts={counts} onClick={() => setTab(e.tab)} />)}
        <span aria-hidden className="pointer-events-none absolute bottom-1 left-0 flex w-1/5 justify-center transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(${at * 100}%)` }} data-nav-indicator>
          <span className="h-[3px] w-6 rounded-full bg-primary" />
        </span>
      </div>
    </nav>
  );
}
