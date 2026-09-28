"use client";
import type { ReactNode } from "react";
import type { LedgerTaskRef } from "@/lib/chat/agents";
import { useT } from "@/lib/i18n";
import { stageChipView, stageSentence, taskIdInName, type StageIcon as IconKind, type StageTone } from "../ledger-stage";

/**
 * 侧栏 agent 行尾的台账阶段小标（ledger-stage.ts 出标签与色调）。宽度按行按钮的 @container 判：
 * 够宽（≥18rem）= 图标 + 任务号 + 阶段；窄侧栏 = 色点 + 阶段，名字优先。整句放 title（桌面悬停），
 * 手机长按走 agent 菜单，菜单标题下面那行就是 LedgerStageLine。
 */

// Tailwind 只认字面量类名，色调不能拼字符串
const TONE: Record<StageTone, { chip: string; dot: string; text: string }> = {
  error: { chip: "bg-error/12 text-error", dot: "bg-error", text: "text-error" },
  warning: { chip: "bg-warning/15 text-warning", dot: "bg-warning", text: "text-warning" },
  primary: { chip: "bg-primary/12 text-primary", dot: "bg-primary", text: "text-primary" },
  success: { chip: "bg-success/12 text-success", dot: "bg-success", text: "text-success" },
  neutral: { chip: "bg-base-content/[0.07] text-base-content/55", dot: "bg-base-content/40", text: "text-base-content/55" },
};

export function LedgerStageChip({ task, name }: { task: LedgerTaskRef; name: string }) {
  const t = useT();
  const v = stageChipView(task);
  const tone = TONE[v.tone];
  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10.5px] font-medium leading-4 ${tone.chip}`}
      title={stageSentence(v, t)}
      data-ledger-stage={task.stage}
    >
      <span aria-hidden className={`size-1.5 rounded-full @[18rem]:hidden ${tone.dot}`} />
      <StageIcon kind={v.icon} className="hidden size-3 @[18rem]:block" />
      {!taskIdInName(name, v.id) && <span className="hidden font-mono @[18rem]:inline">{v.id}</span>}
      <span>{t(v.short)}</span>
      {v.round !== null && <span className="font-mono tabular-nums">R{v.round}</span>}
    </span>
  );
}

/** 长按菜单标题下的一行：「T5 · 返工中 · 第 1 轮」 */
export function LedgerStageLine({ task }: { task: LedgerTaskRef }) {
  const t = useT();
  const v = stageChipView(task);
  return (
    <span className={`mt-0.5 flex items-center gap-1 ${TONE[v.tone].text}`}>
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
