"use client";
import { useT } from "@/lib/i18n";
import { BOUNDARY_TEXT, boundaryLabel, boundaryLeft, boundaryLines, type CtxBoundaryInfo } from "../ctx-boundary-view";

/**
 * 上下文边界小标：「执行类 余 35k」。列表行里只给命中具名策略的会话显示（个人会话走全局，不加标），
 * 用量面板里每个 Claude Code 会话都显示。悬停看压缩线和硬上限；配置有问题时带提示。
 */
export function CtxBoundaryChip({ b, withLabel = true }: { b: CtxBoundaryInfo; withLabel?: boolean }) {
  const t = useT();
  const left = boundaryLeft(b);
  const lines = boundaryLines(b);
  const warn = b.warnings?.length ? `\n${t("配置有问题")}：${b.warnings.join("；")}` : "";
  return (
    <span
      className={`shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums ${BOUNDARY_TEXT[b.level]}`}
      title={`${t("上下文边界")}：${t(boundaryLabel(b.policy))} · ${t("压缩线 {n}", { n: lines.window })} · ${t("硬上限 {n}", { n: lines.cap })}${warn}`}
    >
      {withLabel && <span className="font-sans">{t(boundaryLabel(b.policy))} </span>}
      {left ? t(left.key, { n: left.n }) : t("硬上限 {n}", { n: lines.cap })}
      {warn && " !"}
    </span>
  );
}
