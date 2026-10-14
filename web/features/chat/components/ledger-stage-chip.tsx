"use client";
import type { ReactNode } from "react";
import type { LedgerReviewRef, LedgerTaskRef } from "@/lib/chat/agents";
import { useLang, useT } from "@/lib/i18n";
import { reviewChipView, stageChipView, stageSentence, taskIdInName, type StageIcon as IconKind, type StageTone } from "../ledger-stage";
import { stageChipWords } from "../chip-words";

/**
 * 侧栏 agent 行尾的台账阶段小标（ledger-stage.ts 出标签与色调）。tiers（侧栏行用）按行按钮的 @container 分三档，名字优先：
 * ≥27rem = 图标 + 任务号 + 阶段；≥24rem = 图标 + 阶段；更窄只剩图标、收紧边距（默认侧栏的行约 14rem，要给中文名留 8 个字）。
 * 不传 tiers（图例卡）总是全显示。title / aria-label 是 chip-words.ts 的一句话，
 * 手机看侧栏顶的图例卡（chip-legend.tsx），长按 agent 菜单标题下面那行是 LedgerStageLine。
 */

/** 字色直接用状态 token：浅色主题在 globals.css 里已压深到 ≥4.5:1，深色用原色；中性色深浅各一档透明度 */
const TONE: Record<StageTone, { bg: string; fg: string }> = {
  error: { bg: "bg-error/12", fg: "text-error" },
  warning: { bg: "bg-warning/15", fg: "text-warning" },
  primary: { bg: "bg-primary/12", fg: "text-primary" },
  success: { bg: "bg-success/12", fg: "text-success" },
  neutral: {
    bg: "bg-base-content/[0.07]",
    fg: "text-base-content/[0.78] [[data-theme=dark]_&]:text-base-content/55 dark:[:root:not([data-theme=light])_&]:text-base-content/55",
  },
};
/** 各档的起点（tiers）：阶段字 / 任务号；英文阶段字宽一倍，起点再放宽。档位算法见 tests/web-sidebar-polish-browser.test.ts 的中文长名字 */
const TIER = { zh: { mid: "hidden @[24rem]:inline", id: "hidden @[27rem]:inline" }, en: { mid: "hidden @[26rem]:inline", id: "hidden @[29rem]:inline" } } as const;
const TIGHT = "-ml-1 px-0.5 @[18rem]:ml-0 @[18rem]:px-1";

export function LedgerStageChip({ task, names, tiers = false }: { task: LedgerTaskRef; names: (string | null | undefined)[]; tiers?: boolean }) {
  const lang = useLang();
  const v = stageChipView(task, lang);
  const tone = TONE[v.tone];
  const tier = tiers ? TIER[lang] : { mid: "", id: "" };
  const words = stageChipWords(task, lang);
  return (
    <span
      role="img"
      aria-label={words}
      className={`flex shrink-0 items-center gap-1 rounded py-px text-[10.5px] font-medium leading-4 ${tiers ? TIGHT : "px-1"} ${tone.bg} ${tone.fg}`}
      title={words}
      data-ledger-stage={task.stage}
    >
      <StageIcon kind={v.icon} className="size-3 shrink-0" />
      {!taskIdInName(names, v.id) && <span aria-hidden className={`font-mono ${tier.id}`}>{v.id}</span>}
      <span aria-hidden className={tier.mid}>{v.short}</span>
      {v.round !== null && <span aria-hidden className={`font-mono tabular-nums ${tier.mid}`}>R{v.round}</span>}
    </span>
  );
}

/** 长按菜单标题下的一行：「T5 · 返工中 · 第 1 轮」 */
export function LedgerStageLine({ task }: { task: LedgerTaskRef }) {
  const t = useT();
  const v = stageChipView(task, useLang());
  return <StageLine tone={v.tone} icon={v.icon} sentence={stageSentence(v, t)} />;
}

/**
 * 审查员在审 / 审完的卡（GET /agents 的 ledgerReview）：整句一行，眼睛图标 + 色调。侧栏行上不放（侧栏只放手建 agent 和 PM），
 * 放在协作视图「团队」的成员节点（collab/team-graph-parts.tsx）和长按菜单标题下。
 */
export function LedgerReviewLine({ review }: { review: LedgerReviewRef }) {
  const v = reviewChipView(review, useLang(), useT());
  return <StageLine tone={v.tone} icon="review" sentence={v.sentence} />;
}

function StageLine({ tone, icon, sentence }: { tone: StageTone; icon: IconKind; sentence: string }) {
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
