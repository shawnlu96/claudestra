"use client";
import { useLang, useT } from "@/lib/i18n";
import { BOUNDARY_TEXT, boundaryLabel, boundaryLeft, boundaryLines, type CtxBoundaryInfo } from "../ctx-boundary-view";
import { ctxChipWords } from "../chip-words";

/**
 * 上下文边界小标：「执行类 余 35k」。列表行里只给命中具名策略的会话显示（个人会话走全局，不加标），
 * 用量面板里每个 Claude Code 会话都显示。title / aria-label 是 chip-words.ts 的一句话（不说术语）；配置有问题时带「!」。
 * tiers（侧栏行用）：按行按钮的 @container 缩，名字优先——≥18rem 带类别，≥12rem「余 35k」，更窄只剩数字。
 */
export function CtxBoundaryChip({ b, withLabel = true, tiers = false }: { b: CtxBoundaryInfo; withLabel?: boolean; tiers?: boolean }) {
  const t = useT();
  const words = ctxChipWords(b, useLang());
  const left = boundaryLeft(b);
  const cap = boundaryLines(b).cap;
  const full = left ? t(left.key, { n: left.n }) : t("硬上限 {n}", { n: cap });
  const bare = left ? (left.key === "超 {n}" ? `-${left.n}` : left.n) : cap;
  return (
    <span
      role="img"
      aria-label={words}
      title={words}
      data-chip="ctx"
      className={`shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums ${BOUNDARY_TEXT[b.level]}`}
    >
      {withLabel && <span className={`font-sans ${tiers ? "hidden @[18rem]:inline" : ""}`}>{t(boundaryLabel(b.policy))} </span>}
      {tiers ? (
        <>
          <span className="hidden @[12rem]:inline">{full}</span>
          <span className="@[12rem]:hidden">{bare}</span>
        </>
      ) : (
        full
      )}
      {!!b.warnings?.length && " !"}
    </span>
  );
}
