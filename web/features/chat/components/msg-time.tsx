"use client";
import { fmtTsParts } from "../fmt-ts-parts";
import { useIsExport } from "../export-context";
import { useShare } from "./share-ui";
import type { LeadKind } from "../time-groups";

/**
 * 消息时间的两种常显形态（owner 2026-09-27，取代「点击条目开关显示」——那会让条目高度突变）：
 * - <lg：HeaderTime 放在头像行的另一端（别人 / AI 靠右、本人靠左），今天 HH:mm，否则 MM-DD HH:mm；
 *   ≥lg 时它不是 hidden 而是 sr-only，读屏器仍能读到时间（侧槽标签是 aria-hidden 的纯视觉件）。
 * - ≥lg：GutterTime 放在条目侧槽——消息列 ≥1024px 时左右有 ≥29px margin + 28px padding，够放两行；
 *   absolute 铺满所属块高度的窄列里放一个 sticky 标签，块滚过时标签贴顶跟随。AI 消息按时间分组
 *   （../time-groups.ts），一组一个标签；本人在右槽、其他在左槽。
 *   标签行高取所属块第一行的行高（globals.css 的 --cstra-lead-*，与渲染处共用同一变量；不继承 padding，
 *   保证 sticky 贴顶时各类标签同高）；非今天的带日期行，
 *   两行时行高改 1.5（继承正文行高会让两行间隔过大，owner 2026-09-27）。
 *   hover 形态：AI 消息的每个非组首段也有一个标签，平时透明、鼠标悬停该段时显示（./seg-groups.tsx）。
 * 导出稿（分享）没有侧槽：HeaderTime 常显、GutterTime 不渲染。
 * 分享选择模式下 GutterTime 也不渲染：ShareCheck 的 checkbox 就落在同一侧槽里（share-ui.tsx），会压在数字上。
 */
export function HeaderTime({ ts, className = "" }: { ts?: string; className?: string }) {
  const exporting = useIsExport();
  const p = fmtTsParts(ts);
  if (!p) return null;
  return (
    <time dateTime={ts} className={`${exporting ? "" : "lg:sr-only"} shrink-0 font-mono text-[10px] tabular-nums text-base-content/40 ${className}`}>
      {p.date ? `${p.date} ${p.hm}` : p.hm}
    </time>
  );
}

export type GutterLead = LeadKind | "user" | "system";


export function GutterTime({ ts, side, lead, hover = false }: { ts?: string; side: "left" | "right"; lead: GutterLead; hover?: boolean }) {
  const exporting = useIsExport();
  const sharing = useShare().on;
  const p = fmtTsParts(ts);
  if (!p || exporting || sharing) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 hidden w-[52px] lg:block ${side === "left" ? "-left-[56px] text-right" : "-right-[56px] text-left"} ${
        hover ? "opacity-0 transition-opacity group-hover/seg:opacity-100" : ""
      }`}
    >
      <div className="sticky top-1 font-mono text-[10px] tabular-nums text-base-content/35" style={{ lineHeight: p.date ? 1.5 : `var(--cstra-lead-${lead})` }}>
        {p.date && <div>{p.date}</div>}
        <div>{p.hms}</div>
      </div>
    </div>
  );
}
