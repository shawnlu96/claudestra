"use client";
import type { ReactNode } from "react";
import type { LedgerReviewRef, LedgerTaskRef } from "@/lib/chat/agents";
import { useLang, useT } from "@/lib/i18n";
import { reviewChipView, stageChipView, stageSentence, taskIdInName, type StageIcon as IconKind, type StageTone } from "../ledger-stage";

/**
 * 侧栏 agent 行尾的台账阶段小标（ledger-stage.ts 出标签与色调）。宽度按行按钮的 @container 分三档，名字优先：
 * ≥18rem = 图标 + 任务号 + 阶段；≥11rem（英文 13rem）= 色点 + 阶段；更窄只剩色点。整句放 title（桌面悬停）和 sr-only（读屏），
 * 手机长按走 agent 菜单，菜单标题下面那行就是 LedgerStageLine。
 */

/** 字色直接用状态 token：浅色主题在 globals.css 里已压深到 ≥4.5:1，深色用原色；中性色深浅各一档透明度 */
const TONE: Record<StageTone, { bg: string; dot: string; fg: string }> = {
  error: { bg: "bg-error/12", dot: "bg-error", fg: "text-error" },
  warning: { bg: "bg-warning/15", dot: "bg-warning", fg: "text-warning" },
  primary: { bg: "bg-primary/12", dot: "bg-primary", fg: "text-primary" },
  success: { bg: "bg-success/12", dot: "bg-success", fg: "text-success" },
  neutral: {
    bg: "bg-base-content/[0.07]",
    dot: "bg-base-content/40",
    fg: "text-base-content/[0.78] [[data-theme=dark]_&]:text-base-content/55 dark:[:root:not([data-theme=light])_&]:text-base-content/55",
  },
};
/** 中间档（色点 + 阶段）的起点：英文短名（Review / Verified）比两个汉字宽一倍，默认 16rem 侧栏里的执行者行会把名字挤成省略号，起点放宽到 13rem */
const MID_TIER = { zh: "hidden @[11rem]:inline", en: "hidden @[13rem]:inline" } as const;

export function LedgerStageChip({ task, names }: { task: LedgerTaskRef; names: (string | null | undefined)[] }) {
  const t = useT();
  const v = stageChipView(task, useLang());
  return <Chip v={v} sentence={stageSentence(v, t)} names={names} data={{ "data-ledger-stage": task.stage }} />;
}

/** 长按菜单标题下的一行：「T5 · 返工中 · 第 1 轮」 */
export function LedgerStageLine({ task }: { task: LedgerTaskRef }) {
  const t = useT();
  const v = stageChipView(task, useLang());
  return <ChipLine tone={v.tone} icon={v.icon} sentence={stageSentence(v, t)} />;
}

/** 审查员的审查小标：分档同执行者小标，但卡号从中间档就显示（审查员名字里不会带卡号，「在审哪张」是这枚小标的主信息）；最宽一档多带不为 0 的 P 数 */
export function LedgerReviewChip({ review, names }: { review: LedgerReviewRef; names: (string | null | undefined)[] }) {
  const v = reviewChipView(review, useLang(), useT());
  return <Chip v={v} sentence={v.sentence} names={names} extra={v.counts} idMid data={{ "data-ledger-review": review.verdict ?? "reviewing" }} />;
}

/** 长按菜单标题下的一行：「审完 CLR1 · 第 2 轮 · 要改 · P0 0 / P1 1 / P2 3」 */
export function LedgerReviewLine({ review }: { review: LedgerReviewRef }) {
  const v = reviewChipView(review, useLang(), useT());
  return <ChipLine tone={v.tone} icon={v.icon} sentence={v.sentence} />;
}

type ChipView = { id: string; short: string; tone: StageTone; icon: IconKind; round: number | null };

interface ChipProps {
  v: ChipView;
  sentence: string;
  names: (string | null | undefined)[];
  /** 最宽一档追加的一段（审查的 P 数） */
  extra?: string;
  /** 卡号从中间档就显示（默认只在最宽一档） */
  idMid?: boolean;
  data: Record<string, string>;
}

function Chip({ v, sentence, names, extra, idMid, data }: ChipProps) {
  const tone = TONE[v.tone];
  const mid = MID_TIER[useLang()];
  const idTier = idMid ? mid : "hidden @[18rem]:inline";
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10.5px] font-medium leading-4 ${tone.bg} ${tone.fg}`} title={sentence} {...data}>
      <span className="sr-only">{sentence}</span>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full @[18rem]:hidden ${tone.dot}`} />
      <StageIcon kind={v.icon} className="hidden size-3 @[18rem]:block" />
      {!taskIdInName(names, v.id) && <span aria-hidden className={`font-mono ${idTier}`}>{v.id}</span>}
      <span aria-hidden className={mid}>{v.short}</span>
      {v.round !== null && <span aria-hidden className={`font-mono tabular-nums ${mid}`}>R{v.round}</span>}
      {extra && <span aria-hidden className="hidden font-mono tabular-nums @[18rem]:inline">{extra}</span>}
    </span>
  );
}

function ChipLine({ tone, icon, sentence }: { tone: StageTone; icon: IconKind; sentence: string }) {
  return (
    <span className={`mt-0.5 flex items-center gap-1 ${TONE[tone].fg}`}>
      <StageIcon kind={icon} className="size-3 shrink-0" />
      <span className="truncate">{sentence}</span>
    </span>
  );
}

/** lucide 线条图标（不用 emoji）：file-text / hourglass / code / rotate-ccw / ban / circle-check / x / eye */
function StageIcon({ kind, className }: { kind: IconKind; className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[kind]}
    </svg>
  );
}

const ICON_PATHS: Record<IconKind, ReactNode> = {
  spec: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  wait: (
    <>
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </>
  ),
  build: (
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>
  ),
  fix: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
  done: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  cancel: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  review: (
    <>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};
