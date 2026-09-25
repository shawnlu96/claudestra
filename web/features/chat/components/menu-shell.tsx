"use client";
import type { ReactNode } from "react";

/**
 * 侧栏右键 / 长按菜单的共用外壳（会话菜单 agent-menu.tsx 与 project 菜单 project-menu.tsx）：
 * 全屏遮罩收菜单、fixed 定位在指针旁、放不下就翻到指针上方。行高固定，rows 由调用方按当前页算。
 */
export const MENU_W = 200;
export const ROW_H = 40;

export function MenuItem({ icon, label, onClick, danger, chevron }: { icon: string; label: string; onClick: () => void; danger?: boolean; chevron?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] active:bg-base-300 hover:bg-base-200 ${
        danger ? "text-error" : "text-base-content/85"
      }`}
      onClick={onClick}
    >
      <span className="w-4 shrink-0 text-center opacity-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chevron && <span className="shrink-0 text-[11px] opacity-40">▸</span>}
    </button>
  );
}

/** 菜单项文案：字典 key 里的 {app} 换成程序名（「在 {app} 中打开」→「在 iTerm2 中打开」） */
export function menuLabel(t: (k: string) => string, label: string, arg?: string): string {
  return arg ? t(label).replace("{app}", arg) : t(label);
}

export function MenuShell({ x, y, rows, title, onClose, children }: {
  x: number;
  y: number;
  rows: number;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const h = rows * ROW_H + 30;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, x - 12), vw - MENU_W - 8);
  const below = y + 10;
  const top = below + h < vh - 8 ? below : Math.max(8, y - h - 10);
  return (
    <>
      <div className="fixed inset-0 z-[997]" style={{ touchAction: "none" }} onPointerDown={onClose} />
      <div
        role="menu"
        className="cstra-menu-in fixed z-[998] overflow-hidden rounded-2xl border border-base-300 bg-base-100/97 py-1.5 shadow-xl backdrop-blur"
        style={{ left, top, width: MENU_W }}
      >
        <div className="truncate px-3.5 pb-1 pt-0.5 text-[11px] text-base-content/40">{title}</div>
        {children}
      </div>
    </>
  );
}
