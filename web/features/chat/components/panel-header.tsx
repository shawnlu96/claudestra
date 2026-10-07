"use client";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";

/**
 * ResponsiveShell 面板的顶栏（Agent 管理、批量管理共用）：与会话页 TopBar 同构——安全区自垫、窄屏左侧返回箭头、
 * 宽屏右侧 ✕，两者都走 onClose（窄屏 = history.back）。children 是标题和 ✕ 之间的操作按钮，第一个自己带 ml-auto 靠右。
 */
export function PanelHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  const t = useT();
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-1 border-b border-base-300 bg-base-100 px-3"
      style={{ paddingTop: "var(--cstra-quota-pane-safe-top, env(safe-area-inset-top))" }}>
      <button className="btn btn-ghost btn-sm -ml-1 px-2 sm:hidden" aria-label={t("返回")} onClick={onClose}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <span className="truncate font-semibold">{t(title)}</span>
      {children}
      <button className="btn btn-ghost btn-sm max-sm:hidden" aria-label={t("关闭")} onClick={onClose}>
        ✕
      </button>
    </header>
  );
}
