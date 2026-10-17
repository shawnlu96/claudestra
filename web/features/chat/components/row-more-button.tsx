"use client";
/**
 * 会话行 / project 组头行尾的常显 ⋯（agents-ROWMORE1）：长按 / 右键之外看得见的同一个入口。
 * 点它走的就是那个 trigger 的 open（menu-gestures.ts），菜单状态、内容、动作全是原来那一套；
 * 坐标取按钮自身边界（键盘激活没有指针坐标）。事件不往外冒：不进会话、不折叠、不起拖拽 / 左滑。
 * 注意：从这里按下再拖时 dragstart 落在可拖的行上、到不了本按钮，整行拖拽的拦截在行上（row-drag-origin.ts，agents-MOREDRAG1）。
 */
import type { MouseEvent, SyntheticEvent } from "react";
import { useT } from "@/lib/i18n";
import { buildAgentMenu } from "../agent-menu";
import { useHostInfo } from "../host-info";
import { useFullScope } from "../contacts-data";
import type { AgentSession } from "../type";

/** 横三点（lucide ellipsis；与顶栏 ⋮ 的 ellipsis-vertical 同一套圆点，只是横放） */
export function MoreDotsIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();
const FOCUS = "hover:bg-base-content/10 hover:text-base-content/80 focus-visible:outline-2 focus-visible:outline-primary";

/** 常显 ⋯ 按钮本体。open = trigger 暴露的显式打开（undefined 时调用方就别渲染）。 */
export function RowMoreButton({ open, className = "" }: { open: (x: number, y: number) => void; className?: string }) {
  const t = useT();
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    open(r.left, r.bottom);
  };
  return (
    <button
      type="button"
      data-row-more=""
      aria-label={t("更多操作")}
      title={t("更多操作")}
      aria-haspopup="menu"
      draggable={false}
      className={`grid size-7 shrink-0 place-items-center rounded-md text-base-content/40 transition-colors sm:size-6 ${FOCUS} ${className}`}
      onClick={onClick}
      onPointerDown={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
      onContextMenu={stop}
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <MoreDotsIcon />
    </button>
  );
}

/** 会话行的 ⋯：trigger 未启用（多选 / master / mock）或这台设备上菜单为空（buildAgentMenu 无项）时不留空按钮。 */
export function AgentRowMore({ a, open }: { a: AgentSession; open?: (x: number, y: number) => void }) {
  const host = useHostInfo();
  const full = useFullScope() === true;
  if (!open || !buildAgentMenu(a, host.openers, host.platform, full)?.length) return null;
  return <RowMoreButton open={open} />;
}
