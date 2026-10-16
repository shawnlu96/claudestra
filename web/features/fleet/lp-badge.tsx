"use client";
import { lpBadgeText, lpBadgeTitle, type LpState } from "@/lib/api/fleet";
import { useLang } from "@/lib/i18n";
import { ownerWordsTr } from "@/lib/owner-words";
import { Svg } from "./icons";

/** lucide snail：低优先级开着 */
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

/** lucide ban：低优先级额度用完 */
const BanIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="10" />
    <path d="m4.9 4.9 14.2 14.2" />
  </Svg>
);

/** 侧栏行与批量面板共用的低优先级徽章：线性图标 + 文字，title 是额度那套说法；关着且额度没用完 / 状态不明时不显示。
 * 不自己报额度百分比（额度在「今天 · 团队与额度」看）。词中英文都从 lib/owner-words 取 */
export function LpBadge({ lp }: { lp?: LpState | null }) {
  const words = ownerWordsTr(useLang());
  const text = lpBadgeText(lp, words);
  if (!lp || !text) return null;
  const on = lp.lowPriority === "on";
  const tone = on ? "text-info/80" : lp.lowPriority === "exhausted" ? "text-error/70" : "text-warning/80";
  const title = lpBadgeTitle(lp, words);
  return (
    <span className={`flex shrink-0 items-center gap-0.5 text-[11px] ${tone}`} title={title}>
      {on ? <SnailIcon /> : lp.lowPriority === "exhausted" ? <BanIcon /> : <HourglassIcon />}
      <span className={on ? undefined : "font-mono tabular-nums"}>{text}</span>
    </span>
  );
}
