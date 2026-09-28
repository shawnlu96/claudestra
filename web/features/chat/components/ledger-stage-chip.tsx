"use client";
import type { CSSProperties, ReactNode } from "react";
import type { LedgerTaskRef } from "@/lib/chat/agents";
import { useLang, useT } from "@/lib/i18n";
import { stageChipView, stageSentence, taskIdInName, type StageIcon as IconKind, type StageTone } from "../ledger-stage";

/**
 * 侧栏 agent 行尾的台账阶段小标（ledger-stage.ts 出标签与色调）。宽度按行按钮的 @container 分三档，名字优先：
 * ≥18rem = 图标 + 任务号 + 阶段；≥11rem（英文 13rem）= 色点 + 阶段；更窄只剩色点。整句放 title（桌面悬停）和 sr-only（读屏），
 * 手机长按走 agent 菜单，菜单标题下面那行就是 LedgerStageLine。
 */

/**
 * 字色：浅色主题没定义 warning / success / error，daisyUI 默认的亮色在浅底上只有 1.5～2.4:1，所以浅色用 token 混黑压深一档（选中行底色上约 5.3:1，WCAG 要 ≥4.5），
 * 深色主题用 token 原色。只作用于小标和菜单那一行，不动 globals.css 的全局色（看板等别处也在用）。
 * 深色判定与 daisyUI 同口径：data-theme=dark，或没钉浅色且系统是深色。Tailwind 只认字面量类名，色值走 CSS 变量。
 */
const FG = "text-(--lsc-fg) [[data-theme=dark]_&]:text-(--lsc-fg-d) dark:[:root:not([data-theme=light])_&]:text-(--lsc-fg-d)";
const dim = (token: string, pct: number) => `color-mix(in oklab, var(${token}) ${pct}%, black)`;
const TONE: Record<StageTone, { bg: string; dot: string; fg: string; fgDark: string }> = {
  error: { bg: "bg-error/12", dot: "bg-error", fg: dim("--color-error", 68), fgDark: "var(--color-error)" },
  warning: { bg: "bg-warning/15", dot: "bg-warning", fg: dim("--color-warning", 58), fgDark: "var(--color-warning)" },
  primary: { bg: "bg-primary/12", dot: "bg-primary", fg: "var(--color-primary)", fgDark: "var(--color-primary)" },
  success: { bg: "bg-success/12", dot: "bg-success", fg: dim("--color-success", 60), fgDark: "var(--color-success)" },
  neutral: {
    bg: "bg-base-content/[0.07]",
    dot: "bg-base-content/40",
    fg: "color-mix(in oklab, var(--color-base-content) 78%, transparent)",
    fgDark: "color-mix(in oklab, var(--color-base-content) 55%, transparent)",
  },
};
/** 中间档（色点 + 阶段）的起点：英文短名（Review / Verified）比两个汉字宽一倍，默认 16rem 侧栏里的执行者行会把名字挤成省略号，起点放宽到 13rem */
const MID_TIER = { zh: "hidden @[11rem]:inline", en: "hidden @[13rem]:inline" } as const;
const toneStyle = (tone: StageTone) => ({ "--lsc-fg": TONE[tone].fg, "--lsc-fg-d": TONE[tone].fgDark }) as CSSProperties;

export function LedgerStageChip({ task, names }: { task: LedgerTaskRef; names: (string | null | undefined)[] }) {
  const t = useT();
  const lang = useLang();
  const v = stageChipView(task, lang);
  const tone = TONE[v.tone];
  const mid = MID_TIER[lang];
  const sentence = stageSentence(v, t);
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10.5px] font-medium leading-4 ${tone.bg} ${FG}`}
      style={toneStyle(v.tone)}
      title={sentence}
      data-ledger-stage={task.stage}
    >
      <span className="sr-only">{sentence}</span>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full @[18rem]:hidden ${tone.dot}`} />
      <StageIcon kind={v.icon} className="hidden size-3 @[18rem]:block" />
      {!taskIdInName(names, v.id) && <span aria-hidden className="hidden font-mono @[18rem]:inline">{v.id}</span>}
      <span aria-hidden className={mid}>{v.short}</span>
      {v.round !== null && <span aria-hidden className={`font-mono tabular-nums ${mid}`}>R{v.round}</span>}
    </span>
  );
}

/** 长按菜单标题下的一行：「T5 · 返工中 · 第 1 轮」 */
export function LedgerStageLine({ task }: { task: LedgerTaskRef }) {
  const t = useT();
  const v = stageChipView(task, useLang());
  return (
    <span className={`mt-0.5 flex items-center gap-1 ${FG}`} style={toneStyle(v.tone)}>
      <StageIcon kind={v.icon} className="size-3 shrink-0" />
      <span className="truncate">{stageSentence(v, t)}</span>
    </span>
  );
}

/** lucide 线条图标（不用 emoji）：file-text / hourglass / code / rotate-ccw / ban / circle-check / x */
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
};
