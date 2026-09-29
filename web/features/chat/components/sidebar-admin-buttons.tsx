"use client";
import { useT } from "@/lib/i18n";
import { useFullScope } from "../contacts-data";
import { PeersButton } from "./peers-button";

/**
 * 侧栏顶栏的「项目管理」「多选管理（批量删除）」「Peer 协作」「用量看板」（从 sidebar.tsx 原样搬出）。背后的接口
 * （/projects、删除 agent、/peers、/stats）都要全权凭据：guest、部分 scope 的设备都不出，免得点进去才 403。多选状态仍归 sidebar.tsx 管。
 */
export function SidebarAdminButtons({ manage, onProjects, onToggleManage, onPeers, onStats }: {
  manage: boolean;
  onProjects: () => void;
  onToggleManage: () => void;
  onPeers: () => void;
  onStats: () => void;
}) {
  const t = useT();
  const full = useFullScope() === true;
  if (!full) return null;
  return (
    <>
      {/* v2.21+ 项目管理入口 */}
      <button
        className="flex h-7 items-center justify-center rounded-lg px-1.5 text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
        title={t("项目管理")}
        aria-label={t("项目管理")}
        onClick={onProjects}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      </button>
      <button
        className={`flex h-7 items-center justify-center rounded-lg px-1.5 transition-colors ${
          manage
            ? "text-primary"
            : "text-base-content/50 hover:bg-base-300 hover:text-base-content"
        }`}
        title={manage ? t("退出多选") : t("多选管理（批量删除）")}
        aria-label={manage ? t("退出多选") : t("多选管理")}
        onClick={onToggleManage}
      >
        {manage ? (
          <span className="text-xs font-medium">{t("完成")}</span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 17 2 2 4-4" />
            <path d="m3 7 2 2 4-4" />
            <path d="M13 6h8" />
            <path d="M13 12h8" />
            <path d="M13 18h8" />
          </svg>
        )}
      </button>
      <PeersButton onClick={onPeers} />
      <button
        className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
        title={t("用量看板")}
        aria-label={t("用量看板")}
        onClick={onStats}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3v16a2 2 0 0 0 2 2h16" />
          <path d="M7 13v4" />
          <path d="M12 9v8" />
          <path d="M17 5v12" />
        </svg>
      </button>
    </>
  );
}
