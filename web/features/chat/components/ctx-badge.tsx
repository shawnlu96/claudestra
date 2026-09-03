"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { CTX_ADVICE, CTX_WINDOW, ctxLevel, type CtxLevel } from "../ctx-level";
import { useT } from "@/lib/i18n";

/** 请求压缩时发给 agent 的话——与 composer 警示条的按钮同一句(一处改两处同步)。 */
export const COMPACT_REQUEST_TEXT =
  "上下文占用已经很高了，请执行 /save-compact：先抢救关键记忆，然后压缩上下文。";

const BADGE: Record<CtxLevel, string> = {
  deep: "bg-error text-error-content",
  high: "bg-error/15 text-error",
  mid: "bg-warning/15 text-warning",
  none: "bg-base-300 text-base-content/50",
};

/** 建议表里当前档的高亮底色(与徽章同色系,弱一档) */
const ROW_ON: Record<CtxLevel, string> = {
  deep: "bg-error/15 text-error",
  high: "bg-error/10 text-error",
  mid: "bg-warning/15 text-warning",
  none: "bg-base-200 text-base-content/70",
};

/**
 * 顶栏上下文徽章(2026-07-14 owner:context 超标 web 端毫无提示)+ v2.21.3+ 点开的
 * 「什么时候压」建议卡(owner 2026-09-03:把 save-compact 时机表做成 UI 提示)。
 * 原则是**按任务边界压,上下文只决定找边界的紧迫程度**——卡片列四档、高亮当前档,
 * 底部一键「存记忆 + Compact」(与 composer 警示条同一条请求)。<200k 不打扰(不显示)。
 */
export function CtxBadge({ agent }: { agent: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点面板外任意处关闭(与 ClaudeSwitcher 同款)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const tokens = agent.contextTokens;
  if (typeof tokens !== "number" || tokens < 200_000) return null;
  const level = ctxLevel(tokens);
  const k = Math.round(tokens / 1000);
  const pct = Math.round((tokens / CTX_WINDOW) * 100);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        className={`rounded-full px-2 py-0.5 font-mono text-[10.5px] tabular-nums transition-opacity hover:opacity-80 ${BADGE[level]}`}
        title={t("当前会话上下文占用,点开看压缩建议")}
        onClick={() => setOpen((v) => !v)}
      >
        ctx {k}k
      </button>
      {open && (
        <div className="panel-pop absolute left-0 top-full z-30 mt-1.5 w-72 max-w-[88vw] rounded-xl border border-base-content/10 bg-base-100 p-3 shadow-lg">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12px] font-semibold">{t("上下文")}</span>
            <span className="font-mono text-[11px] tabular-nums text-base-content/60">
              {k}k · {pct}% / 1M
            </span>
          </div>
          <div className="mb-2 text-[11px] leading-snug text-base-content/55">
            {t("按任务边界压,别盯死数字——上下文只决定找边界的紧迫程度。压之前先存记忆(save-compact)。")}
          </div>
          <div className="flex flex-col gap-0.5">
            {CTX_ADVICE.map((row) => {
              const on = row.level === level;
              return (
                <div
                  key={row.level}
                  className={`flex items-start gap-2 rounded-md px-2 py-1 text-[11.5px] leading-snug ${
                    on ? ROW_ON[level] + " font-medium" : "text-base-content/60"
                  }`}
                >
                  <span className="w-[5.2rem] shrink-0 font-mono tabular-nums">{row.range}</span>
                  <span className="min-w-0">{t(row.advice)}</span>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="btn btn-warning btn-xs mt-2.5 w-full"
            disabled={sent || agent.compacting === true}
            onClick={() => {
              if (sent) return; // 双击兜底
              setSent(true);
              void store.send(COMPACT_REQUEST_TEXT);
              setOpen(false);
            }}
          >
            {agent.compacting ? t("压缩中…") : sent ? t("已请求") : `🧹 ${t("存记忆 + Compact")}`}
          </button>
        </div>
      )}
    </div>
  );
}
