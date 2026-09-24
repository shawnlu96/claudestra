"use client";
import { useEffect, useSyncExternalStore } from "react";
import { getShare, subscribeShare, toggleShare, clickMessage, setShareOn, type ShareState } from "../share-mode";
import { useT } from "@/lib/i18n";
import { useChatStore } from "../chat-store";
import type { ChatMessage } from "../type";

/** 分享模式下消息行的包装类:留出 checkbox 那一格(本人右、其余左),选中加底色 */
export function shareRowClass(m: ChatMessage, flash: boolean, on: boolean, selected: boolean): string | undefined {
  const parts: string[] = [];
  if (flash) parts.push("cstra-flash");
  if (on) parts.push("relative", m.role === "user" && !m.from ? "pr-8" : "pl-8");
  // 直角、淡蓝（owner 2026-09-25「不必有圆角…背景稍微淡一点，用蓝色系」）
  if (selected) parts.push("bg-info/[0.06]");
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * 选择模式下罩在每条消息上的透明 mask：点整条即选中 / 取消，顺便挡住底下组件的交互
 * （owner 2026-09-25「不必非要点击那个 checkbox」）。checkbox 在它上面一层，点到也是同一件事。
 */
export function ShareMask({ id, order }: { id: string; order: readonly string[] }) {
  return (
    <div
      className="absolute inset-0 z-10 cursor-pointer"
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
        clickMessage(id, order);
      }}
    />
  );
}

/** 分享模式状态（组件订阅入口；规则在 ../share-mode.ts） */
export function useShare(): ShareState {
  return useSyncExternalStore(subscribeShare, getShare, getShare);
}

function ShareIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.59 13.51 6.83 3.98" />
      <path d="m15.41 6.51-6.82 3.98" />
    </svg>
  );
}

/** 分享入口的开关态 + 文案（顶栏按钮与窄屏菜单项同一套：工作中禁用并说明原因） */
function useShareEntry(busy: boolean): { on: boolean; label: string } {
  const t = useT();
  const { on } = useShare();
  return { on, label: busy ? t("工作中不能分享") : on ? t("退出分享") : t("分享") };
}

/** 顶栏分享按钮：进入 / 退出选择模式，激活态高亮（owner 2026-09-24）。
 *  会话工作中禁用；正选着的时候回合开始了就自动退出（owner 2026-09-25「工作中的会话禁止分享」）。 */
export function ShareButton({ busy = false }: { busy?: boolean }) {
  const { on, label } = useShareEntry(busy);
  const active = useChatStore((s) => s.state.activeAgent);
  useEffect(() => {
    if (busy && on) setShareOn(false);
  }, [busy, on]);
  // 切会话即退出分享模式（peer review #43「切换会话后分享模式还开着」）；本来就关着时是空操作
  useEffect(() => {
    setShareOn(false);
  }, [active]);
  return (
    <button
      className={`btn btn-ghost btn-sm px-2 ${on ? "bg-primary/10 text-primary" : "text-base-content/60 hover:text-base-content"}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={busy}
      onClick={toggleShare}
    >
      <ShareIcon size={16} />
    </button>
  );
}

/** 窄屏折叠菜单里的分享项：纯触发，禁用语义同 ShareButton（上面两个自动退出的守卫只在 ShareButton 里跑一份） */
export function ShareMenuItem({ busy, className, onPick }: { busy: boolean; className?: string; onPick: () => void }) {
  const { on, label } = useShareEntry(busy);
  return (
    <li className={className}>
      <button
        className={on ? "text-primary" : undefined}
        aria-pressed={on}
        disabled={busy}
        onClick={() => {
          onPick();
          toggleShare();
        }}
      >
        <ShareIcon size={15} />
        {label}
      </button>
    </li>
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
      className={`absolute top-0 z-20 flex size-[22px] items-center justify-center rounded-md border transition-colors ${
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
