"use client";
/**
 * 一格入口（NAVBAR1）：线性图标 + 两字名，选中用主色；右上角件数（「今天」= 要你处理，「会话」= 未读合计，0 不出）。
 * 手机底部栏五格、电脑图标栏四格共用；指示条由各自的栏画（底部横条平移 / 左侧竖条）。
 */
import { badgeText, type NavEntry } from "./nav-entries";
import { NavIcon } from "./nav-icons";
import { useNavT } from "./use-nav-t";

/** waits = 等你处理的 asks 件数（同 TODAY1 收起行的 M），unread = 会话未读合计（全部会话，同标签页标题与 App 角标的口径） */
export interface NavCounts { waits: number; unread: number }

const TONE = { waits: "bg-warning text-warning-content", unread: "bg-accent text-white" } as const;
const ARIA = { waits: "{n} 件要你处理", unread: "{n} 条未读" } as const;

export function NavButton({ e, on, counts, onClick, className = "" }: { e: NavEntry; on: boolean; counts: NavCounts; onClick: () => void; className?: string }) {
  const tr = useNavT();
  const n = e.badge ? counts[e.badge] : 0;
  const badge = badgeText(n);
  const label = tr(e.label);
  return (
    <button type="button" aria-current={on ? "page" : undefined} data-nav-tab={e.tab} onClick={onClick}
      aria-label={badge && e.badge ? `${label} · ${tr(ARIA[e.badge], { n })}` : undefined}
      className={`flex flex-col items-center justify-center gap-0.5 text-[11px] transition-colors ${on ? "font-medium text-primary" : "text-base-content/60 hover:text-base-content"} ${className}`}>
      <span className="relative">
        <NavIcon name={e.icon} />
        {badge && e.badge && (
          <span className={`absolute -right-2.5 -top-1.5 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 tabular-nums ${TONE[e.badge]}`} data-nav-badge={e.badge}>
            {badge}
          </span>
        )}
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
