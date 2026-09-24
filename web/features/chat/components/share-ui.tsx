"use client";
import { useSyncExternalStore } from "react";
import { getShare, subscribeShare, toggleShare, clickMessage, type ShareState } from "../share-mode";
import { useT } from "@/lib/i18n";
import type { ChatMessage } from "../type";

/** 分享模式下消息行的包装类:留出 checkbox 那一格(本人右、其余左),选中加底色 */
export function shareRowClass(m: ChatMessage, flash: boolean, on: boolean, selected: boolean): string | undefined {
  const parts: string[] = [];
  if (flash) parts.push("cstra-flash");
  if (on) parts.push("relative rounded-xl", m.role === "user" && !m.from ? "pr-8" : "pl-8");
  if (selected) parts.push("bg-primary/[0.08]");
  return parts.length ? parts.join(" ") : undefined;
}

/** 分享模式状态（组件订阅入口；规则在 ../share-mode.ts） */
export function useShare(): ShareState {
  return useSyncExternalStore(subscribeShare, getShare, getShare);
}

/** 顶栏分享按钮：进入 / 退出选择模式，激活态高亮（owner 2026-09-24） */
export function ShareButton() {
  const t = useT();
  const { on } = useShare();
  return (
    <button
      className={`btn btn-ghost btn-sm px-2 ${on ? "bg-primary/10 text-primary" : "text-base-content/60 hover:text-base-content"}`}
      title={on ? t("退出分享") : t("分享")}
      aria-label={on ? t("退出分享") : t("分享")}
      aria-pressed={on}
      onClick={toggleShare}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="m8.59 13.51 6.83 3.98" />
        <path d="m15.41 6.51-6.82 3.98" />
      </svg>
    </button>
  );
}

/**
 * 每条消息旁的 checkbox（选择模式才渲染）：本人在右、其余在左，钉在头行那一格
 * （22px 头像的高度）。点击走连续范围规则；其余区域照常可交互。
 */
export function ShareCheck({ id, order, checked, side }: { id: string; order: readonly string[]; checked: boolean; side: "left" | "right" }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`absolute top-0 flex size-[22px] items-center justify-center rounded-md border transition-colors ${
        side === "right" ? "right-0" : "left-0"
      } ${checked ? "border-primary bg-primary text-primary-content" : "border-base-content/30 bg-base-100 hover:border-base-content/60"}`}
      onClick={(e) => {
        e.stopPropagation();
        clickMessage(id, order);
      }}
    >
      {checked && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}
