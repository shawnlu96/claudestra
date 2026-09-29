"use client";
import { useT } from "@/lib/i18n";

/**
 * 侧栏底部可折叠分区（未纳管会话 / 归档）的组头，两处共用一份：字号、颜色、计数、刷新钮必须一致（曾各写一份，
 * 归档那份字大一号还更亮）。刷新钮给 36×36 的触摸格子——裸字符在手机上点不中、还会被旁边的折叠按钮吃掉。
 */
export function SidebarSectionHeader(p: {
  icon: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  /** null = 还没拉到（折叠态也给计数：不给条数用户没有点开的动机） */
  count: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div className="flex w-full items-center">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] font-medium tracking-wide text-base-content/55 transition-colors hover:text-base-content/85"
        onClick={p.onToggle}
        aria-expanded={p.open}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-base-content/40 transition-transform ${p.open ? "" : "-rotate-90"}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span className="shrink-0 text-[13px] opacity-80">{p.icon}</span>
        <span className="truncate">{p.label}</span>
        {p.count !== null ? (
          <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/40">{p.count}</span>
        ) : p.loading ? (
          <span className="ml-auto loading loading-spinner loading-xs" />
        ) : null}
      </button>
      {p.open ? (
        <button
          type="button"
          className="grid size-9 shrink-0 touch-manipulation place-items-center rounded-md text-base text-base-content/45 transition-colors hover:text-base-content/80 active:bg-base-200/70"
          title={t("刷新")}
          disabled={p.loading}
          onClick={(e) => {
            e.stopPropagation();
            p.onRefresh();
          }}
        >
          ⟳
        </button>
      ) : null}
    </div>
  );
}
