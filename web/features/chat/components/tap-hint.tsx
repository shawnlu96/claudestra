"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const W = 260; // 提示最宽；靠屏幕边时整体往里挪

/**
 * 点一下弹轻提示：手机没有悬停，title 看不到（owner 2026-09-29 问「小信箱和数字是什么意思」）。桌面照旧有 title。
 * 小标长在整行的 <button> 里（点行 = 打开会话），所以点击要截住冒泡，不然就跳进聊天；按钮里不能再套按钮，
 * 用 span role="button"，文案同时进 aria-label。提示 portal 到 body（侧栏在横滑容器里，fixed 会被 transform 困住），
 * 3 秒、点别处或滚动就收。
 */
export function TapHint({ text, className, children }: { text: string; className?: string; children: ReactNode }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!at) return;
    // 点小标 / 提示本身交给它们的 onClick（这里先收掉的话，小标紧接着的 click 会把它又打开，提示则被抽走、click 落到下面那行）
    const off = (e?: Event) => {
      const inside = e?.type === "pointerdown" && [anchor.current, box.current].some((el) => el?.contains(e.target as Node));
      if (!inside) setAt(null);
    };
    const id = setTimeout(() => off(), 3000);
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("scroll", off, true);
    return () => {
      clearTimeout(id);
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("scroll", off, true);
    };
  }, [at]);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8);
    setAt({ left: Math.max(8, left), top: r.bottom + 6 });
  };
  return (
    <span
      ref={anchor}
      role="button"
      aria-label={text}
      title={text}
      data-tap-hint=""
      className={className}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (at) setAt(null);
        else show(e.currentTarget);
      }}
    >
      {children}
      {at &&
        createPortal(
          // 点提示本身 = 收起；截住冒泡，不冒到小标（会重新打开）或整行（会跳进聊天）
          <span
            ref={box}
            role="tooltip"
            onClick={(e) => {
              e.stopPropagation();
              setAt(null);
            }}
            className="fixed z-[70] rounded-lg bg-neutral px-2.5 py-1.5 text-xs leading-snug text-neutral-content shadow-lg"
            style={{ left: at.left, top: at.top, maxWidth: W }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
