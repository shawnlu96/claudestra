"use client";
import { lpBadgeText, type LpState } from "@/lib/api/fleet";
import { useLang, useT } from "@/lib/i18n";
import { LP_WORDS, ownerWordsTr } from "@/lib/owner-words";
import { Svg } from "./icons";

/** lucide snail：low-priority 开着 */
export const SnailIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <path d="M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0" />
    <circle cx="10" cy="13" r="8" />
    <path d="M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6" />
    <path d="M18 3 19.1 5.2" />
    <path d="M22 3 20.9 5.2" />
  </Svg>
);

/** lucide hourglass：额度用完，等重置 */
const HourglassIcon = () => (
  <Svg>
    <path d="M5 22h14" />
    <path d="M5 2h14" />
    <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
    <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
  </Svg>
);

/** lucide ban：本周 low-priority 额度用完 */
const BanIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="10" />
    <path d="m4.9 4.9 14.2 14.2" />
  </Svg>
);

/** 侧栏行与批量面板共用的 low-priority 徽章；关着且额度没用完 / 状态不明时不显示。徽章上的词中英文都从 lib/owner-words 取 */
export function LpBadge({ lp }: { lp?: LpState | null }) {
  const t = useT();
  const words = ownerWordsTr(useLang());
  const text = lpBadgeText(lp, words);
  if (!lp || !text) return null;
  const on = lp.lowPriority === "on";
  const tone = on ? "text-info/80" : lp.lowPriority === "exhausted" ? "text-error/70" : "text-warning/80";
  const title = on
    ? t("low-priority 开着，到 {time}{pct}", { time: lp.resetsAt ?? "?", pct: lp.allowancePct !== undefined ? ` · ${lp.allowancePct}%` : "" })
    : lp.lowPriority === "exhausted"
      ? t("本周 low-priority 额度已用完")
      : words(LP_WORDS.walledTitle, { time: lp.resetsAt ?? "?" });
  return (
    <span className={`flex shrink-0 items-center gap-0.5 text-[11px] ${tone}`} title={title}>
      {on ? <SnailIcon /> : lp.lowPriority === "exhausted" ? <BanIcon /> : <HourglassIcon />}
      <span className="font-mono tabular-nums">{text}</span>
    </span>
  );
}
