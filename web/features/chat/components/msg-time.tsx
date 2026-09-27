"use client";
import { fmtTsParts } from "../fmt-ts-parts";
import { useIsExport } from "../export-context";

/**
 * 消息时间的两种常显形态（owner 2026-09-27，取代「点击条目开关显示」——那会让条目高度突变）：
 * - <lg：HeaderTime 放在头像行的另一端（别人 / AI 靠右、本人靠左），今天 HH:mm，否则 MM-DD HH:mm。
 * - ≥lg：GutterTime 放在条目侧槽——消息列 ≥1024px 时左右有 ≥29px margin + 28px padding，够放两行；
 *   absolute 铺满条目高度的窄列里放一个 sticky 标签，长条目滚过时标签贴着滚动区顶部跟随。
 *   本人在右槽、其他在左槽；今天只一行 HH:mm:ss，否则上 MM-DD 下 HH:mm:ss。
 * 导出稿（分享）没有侧槽：HeaderTime 常显、GutterTime 不渲染。
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

export function GutterTime({ ts, side }: { ts?: string; side: "left" | "right" }) {
  const exporting = useIsExport();
  const p = fmtTsParts(ts);
  if (!p || exporting) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 hidden w-[52px] lg:block ${side === "left" ? "-left-[56px] text-right" : "-right-[56px] text-left"}`}
    >
      <div className="sticky top-2 font-mono text-[10px] leading-tight tabular-nums text-base-content/35">
        {p.date && <div>{p.date}</div>}
        <div>{p.hms}</div>
      </div>
    </div>
  );
}
