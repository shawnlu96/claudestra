"use client";
import type { ReactNode } from "react";
import type { SidebarEntry } from "../sidebar-entries";
import { useAgentDrop } from "./agent-dnd";

type GroupEntry = Extract<SidebarEntry, { kind: "group" }>;

/** 组头 / 「💤 沉寂」共用的开合箭头：open 朝下，收起转成朝右。 */
export function Chevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"} ${className}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * 侧栏 project 组（从 sidebar.tsx 原样搬出）+ 拖拽放置目标：把 agent 行拖到组头 /
 * 组块上 = 转到这个 project（悬停整块高亮）。
 *
 * v2.21.1+ 组做成「容器」(owner 2026-08-31「文件夹层级更清晰」)：组块淡底色 +
 * 开合文件夹图标 + 成员缩进导线——文件夹是个盒子，不再只是一行标签。
 * v2.21.4 组头降为「分区标签」(小号、压淡、无卡片底、hover 只提亮文字)：组头与
 * agent 行此前都是「emoji + 名字」的卡片样式，分不清哪个能点进会话 (owner 2026-09-06)。
 * 现在：卡片 = agent，标签 = 文件夹。
 */
export function ProjectGroup({
  e,
  collapsed,
  groupBusy,
  onToggle,
  children,
}: {
  e: GroupEntry;
  collapsed: boolean;
  groupBusy: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { over, handlers } = useAgentDrop({ projectId: e.id });
  return (
    <li
      className={`rounded-xl p-1 transition-colors ${over ? "bg-primary/15 ring-1 ring-primary/40" : "bg-base-300/25"}`}
      {...handlers}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] font-medium tracking-wide text-base-content/55 transition-colors hover:text-base-content/85"
        onClick={onToggle}
      >
        <Chevron open={!collapsed} className="text-base-content/40" />
        <span className="shrink-0 text-[13px] opacity-80">{e.meta?.emoji || (collapsed ? "📁" : "📂")}</span>
        <span className="truncate">{e.meta?.name || e.id}</span>
        <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/40">{e.items.length}</span>
        {collapsed && groupBusy && <span className="size-1.5 shrink-0 rounded-full bg-warning" />}
      </button>
      {!collapsed && (
        <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5">{children}</ul>
      )}
    </li>
  );
}
