"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLang, useT } from "@/lib/i18n";
import type { LedgerTaskRef } from "@/lib/chat/agents";
import type { CtxBoundaryInfo } from "../ctx-boundary-view";
import { ctxChipWords, rowStateWords, stageWords, type RowState } from "../chip-words";
import { polishWord } from "../sidebar-polish-i18n";
import { CtxBoundaryChip } from "./ctx-boundary-chip";
import { LedgerStageChip } from "./ledger-stage-chip";
import { InfoIcon } from "./line-icons";

/**
 * 会话行芯片的图例（UXSIDE1）：手机没有悬停，「会话」标题旁一个 ⓘ，点开一张卡，逐行是真实芯片 + chip-words.ts 的同一句话。
 * 卡片常驻 DOM，开合靠 opacity / translate / scale / visibility 过渡（Tailwind 4 的 scale-* 写的是 scale 属性，不是 transform）（收起时 invisible，不进读屏和 Tab 序）；点卡外或 Esc 收起。
 * 只在 sm 以下出现：桌面芯片自带 title，顶栏那排按钮也没有多余的宽度。卡片挂在顶栏行（relative）下面，宽度跟顶栏走。
 */

/** 字 / 状态点的分界：挂着上下文 / 阶段芯片的行（dense）要给名字留 8 个字，<18rem 就缩成点；其余行 <12rem 才缩 */
const STATE_TIER = {
  dense: { box: "-ml-1 @[18rem]:ml-0 @[18rem]:pl-1", text: "hidden @[18rem]:inline", dot: "@[18rem]:hidden" },
  loose: { box: "pl-1", text: "hidden @[12rem]:inline", dot: "@[12rem]:hidden" },
} as const;

/** 行尾「工作中」「压缩中」：按行按钮的 @container 显字或缩成状态点（agent-row.tsx 与图例共用） */
export function RowStateChip({ state, dense = false }: { state: RowState; dense?: boolean }) {
  const t = useT();
  const words = rowStateWords(state, useLang());
  const busy = state === "busy";
  const tier = STATE_TIER[dense ? "dense" : "loose"];
  return (
    <span role="img" aria-label={words} title={words} data-chip={state}
      className={`flex shrink-0 items-center text-[11px] ${tier.box} ${busy ? "text-warning-soft-80" : "text-info-soft-80"}`}>
      <span className={tier.text}>{t(busy ? "工作中" : "压缩中")}</span>
      <span className={`size-1.5 rounded-full ${tier.dot} ${busy ? "bg-warning" : "bg-info"}`} />
    </span>
  );
}

const CTX_SAMPLES: CtxBoundaryInfo[] = [
  { policy: "coordinator", window: 200_000, hardCap: 250_000, remaining: 77_000, level: "ok" },
  { policy: "executor", window: 200_000, hardCap: 250_000, remaining: -12_000, level: "over" },
];
const STAGE_SAMPLES: LedgerTaskRef[] = (["build", "review", "fix", "merge", "live", "verified", "blocked"] as const).map((stage) => ({
  id: "T1",
  stage,
  round: stage === "review" ? 2 : stage === "fix" ? 1 : 0,
}));
const STATE_SAMPLES: RowState[] = ["busy", "compacting"];

function LegendRow({ chip, words }: { chip: ReactNode; words: string }) {
  return (
    <li className="flex items-center gap-3 py-1" data-legend-row>
      <span className="flex w-24 shrink-0">{chip}</span>
      <span className="min-w-0 text-[12.5px] leading-snug text-base-content/75">{words}</span>
    </li>
  );
}

function LegendCard() {
  const lang = useLang();
  const head = (s: string) => <li className="pt-1.5 text-[11px] font-medium text-base-content/45 first:pt-0">{polishWord(lang, s)}</li>;
  return (
    <ul className="@container">
      {head("上下文余量")}
      {CTX_SAMPLES.map((b) => <LegendRow key={b.policy} chip={<CtxBoundaryChip b={b} />} words={ctxChipWords(b, lang)} />)}
      {head("卡片阶段")}
      {STAGE_SAMPLES.map((task) => <LegendRow key={task.stage} chip={<LedgerStageChip task={task} names={[]} />} words={stageWords(task.stage, lang)} />)}
      {head("运行状态")}
      {STATE_SAMPLES.map((s) => <LegendRow key={s} chip={<RowStateChip state={s} />} words={rowStateWords(s, lang)} />)}
    </ul>
  );
}

export function ChipLegend() {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const label = polishWord(lang, open ? "收起图例" : "这些标记是什么意思");
  return (
    <span ref={boxRef} className="sm:hidden">
      <button type="button" aria-expanded={open} aria-controls="cstra-chip-legend" title={label} aria-label={label} onClick={() => setOpen((v) => !v)}
        className={`ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors ${open ? "text-primary" : "text-base-content/45"}`}>
        <InfoIcon size={15} />
      </button>
      <div id="cstra-chip-legend" role="region" aria-label={polishWord(lang, "这些标记是什么意思")} data-open={open || undefined}
        className={`absolute inset-x-0 top-full z-30 origin-top rounded-2xl border border-base-300 bg-base-100 px-3.5 py-3 shadow-xl
          transition-[opacity,translate,scale,visibility] duration-150 ease-out motion-reduce:transition-none
          ${open ? "visible scale-100 opacity-100" : "invisible -translate-y-1 scale-[0.97] opacity-0"}`}>
        <LegendCard />
      </div>
    </span>
  );
}
