"use client";
import { fmtTsParts } from "../fmt-ts-parts";
import { useIsExport } from "../export-context";
import { useShare } from "./share-ui";
import type { LeadKind } from "../time-groups";

/**
 * 消息时间的两种常显形态（owner 2026-09-27，取代「点击条目开关显示」——那会让条目高度突变）：
 * - <lg：HeaderTime 放在头像行的另一端（别人 / AI 靠右、本人靠左），今天 HH:mm，否则 MM-DD HH:mm。
 * - ≥lg：GutterTime 放在条目侧槽——消息列 ≥1024px 时左右有 ≥29px margin + 28px padding，够放两行；
 *   absolute 铺满所属块高度的窄列里放一个 sticky 标签，块滚过时标签贴顶跟随。AI 消息按时间分组
 *   （../time-groups.ts），一组一个标签；本人在右槽、其他在左槽。
 *   标签行高取所属块第一行的行高（不继承 padding，保证 sticky 贴顶时各类标签同高）；非今天的带日期行，
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
    <span className={`${exporting ? "" : "lg:hidden"} shrink-0 font-mono text-[10px] tabular-nums text-base-content/40 ${className}`}>
      {p.date ? `${p.date} ${p.hm}` : p.hm}
    </span>
  );
}

export type GutterLead = LeadKind | "user" | "system";

/** 各类块第一行的行高（与渲染处的类名保持一致；改了那边要同步这里）。标签不继承块的 padding-top：
 *  继承会让本人气泡（py-[11px]）的标签 sticky 贴顶时比其他标签低 11px（owner 2026-09-27），一律从 0 起。 */
const LEAD: Record<GutterLead, string> = {
  narr: "calc(var(--chat-narr-size, 13.5px) * 1.375)",
  note: "calc((var(--chat-narr-size, 13.5px) - 1px) * 1.375)",
  body: "calc(var(--chat-font-size, 16px) * var(--chat-line-height, 1.625))",
  tool: "calc(var(--chat-tool-size, 12px) + 16px)",
  user: "calc(var(--chat-font-size, 14.5px) * var(--chat-line-height, 1.6))",
  system: "16px",
};

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
      <div className="sticky top-1 font-mono text-[10px] tabular-nums text-base-content/35" style={{ lineHeight: p.date ? 1.5 : LEAD[lead] }}>
        {p.date && <div>{p.date}</div>}
        <div>{p.hms}</div>
      </div>
    </div>
  );
}
