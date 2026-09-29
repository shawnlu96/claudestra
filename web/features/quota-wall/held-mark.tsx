"use client";
import { useT } from "@/lib/i18n";

/**
 * 被 bridge 押住的乐观气泡（m.held，features/quota-wall/held-send.ts）下面的标记：说明那条系统行不是历史，重连 / 回前台对齐后就没了，
 * 气泡自己得看得出「押着、还没送到」（T24 wf3 delivery-hold-6）。送达后历史里有了这条，乐观气泡被对账掉，标记随之消失。
 */
export function HeldMark() {
  const t = useT();
  return (
    <div className="flex items-center gap-1 pr-1 text-[11px] font-medium text-base-content/50" data-held-mark>
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <line x1="10" x2="10" y1="15" y2="9" />
        <line x1="14" x2="14" y1="15" y2="9" />
      </svg>
      <span>{t("押着，送达后出现在对话里")}</span>
    </div>
  );
}
