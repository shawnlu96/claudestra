"use client";
import { useT } from "@/lib/i18n";

/** lucide users：external（可共享给 peer）的统一标识，侧栏图标角标与顶栏徽章共用 */
export function UsersIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** 顶栏左侧的 external 徽章（owner 2026-09-27）：有共享给 peer 时右上角挂个数字角标 */
export function ExternalBadge({ count }: { count: number }) {
  const t = useT();
  const title = count > 0 ? `${t("对外共享（external）")} · ${t("已共享给")} ${count} peer` : t("对外共享（external）");
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center rounded-md bg-base-content/[0.08] p-1 text-base-content/60" title={title} aria-label={title}>
      <UsersIcon size={13} />
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 min-w-[14px] rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-[14px] text-primary-content">
          {count}
        </span>
      )}
    </span>
  );
}
