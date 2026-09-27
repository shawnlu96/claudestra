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

/** 顶栏的 external 徽章（owner 2026-09-27）：有共享给 peer 时右上角挂个数字角标；
 *  桌面端悬停出 peer 名单（owner 2026-09-28，移动端没有 hover 不展示——数字够用）。 */
export function ExternalBadge({ count, peers = [] }: { count: number; peers?: string[] }) {
  const t = useT();
  const title = count > 0 ? `${t("对外共享（external）")} · ${t("已共享给")} ${count} peer` : t("对外共享（external）");
  return (
    <span
      className="group/ext relative inline-flex shrink-0 items-center justify-center rounded-md bg-base-content/[0.08] p-1 text-base-content/60"
      aria-label={title}
      title={peers.length ? undefined : title}
    >
      <UsersIcon size={13} />
      {count > 0 && (
        <span className="absolute -right-1.5 -top-1.5 min-w-[14px] rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-[14px] text-primary-content">
          {count}
        </span>
      )}
      {peers.length > 0 && (
        <span
          role="tooltip"
          className={
            "pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden whitespace-nowrap rounded-lg border border-base-300 bg-base-100 px-2.5 py-1.5 " +
            "text-left text-[11px] font-normal text-base-content shadow-lg lg:group-hover/ext:block"
          }
        >
          <span className="block text-[10px] text-base-content/50">{t("已共享给")}</span>
          {peers.map((p) => (
            <span key={p} className="block font-mono">{p}</span>
          ))}
        </span>
      )}
    </span>
  );
}
