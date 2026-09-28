"use client";
/**
 * 输入框上方的 @ 层（状态在 ../use-mention.ts）：候选列表（样式、防抢焦点与 slash 面板一致）、
 * 已选目标的提示条（写明「发送时让当前 agent 转达」，✕ 取消委托、文字留着），以及发送前复核失败的原因。
 * 名字都是普通文本节点渲染：对方 agent 名是不可信输入，不进 HTML。
 */
import { useT } from "@/lib/i18n";
import { mentionLabel } from "@/lib/chat/mention-directive";
import type { MentionCandidate } from "../mention";
import type { MentionState } from "../use-mention";
import { presenceTone } from "./contacts-group";

/** lucide at-sign */
function AtIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

/** lucide x */
function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function CandidateRow({ c, selected, onPick }: { c: MentionCandidate; selected: boolean; onPick: () => void }) {
  const t = useT();
  const busyText = c.busy === true ? t("忙") : c.busy === false ? t("空闲") : "—";
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 px-3.5 py-2 text-left ${selected ? "bg-base-200" : ""}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className={`size-2 shrink-0 rounded-full ${presenceTone(c.online, c.busy)}`} />
      <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] font-semibold">@{c.label}</span>
      <span className="shrink-0 text-[11px] text-base-content/45">{busyText}</span>
      <span className="shrink-0 rounded bg-base-200 px-1.5 py-0.5 text-[10px] text-base-content/45">
        {c.target.kind === "peer" ? c.target.peer : t("本机")}
      </span>
    </button>
  );
}

export function MentionLayer({ m, active }: { m: MentionState; active: string }) {
  const t = useT();
  return (
    <>
      {m.error && <div className="mb-1.5 rounded-xl border border-error/30 bg-error/10 px-3 py-1.5 text-xs text-error">{m.error}</div>}
      {m.target && (
        <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs">
          <span className="shrink-0 text-accent"><AtIcon /></span>
          <span className="min-w-0 flex-1 break-words leading-snug">
            {t("发送时让 {me} 去找 {who}，并把回复带回来", { me: active, who: mentionLabel(m.target) })}
          </span>
          <button
            type="button"
            className="shrink-0 p-0.5 opacity-50 hover:opacity-90"
            aria-label={t("取消转达")}
            title={t("取消转达")}
            onPointerDown={(e) => e.preventDefault()}
            onClick={m.clear}
          >
            <XIcon />
          </button>
        </div>
      )}
      {m.open && (
        <div className="mb-1.5 max-h-[42dvh] touch-pan-y overflow-y-auto overscroll-contain rounded-xl border border-base-content/10 bg-base-100 shadow-lg">
          {m.items.map((c, i) => (
            <CandidateRow key={`${c.target.kind}:${c.label}`} c={c} selected={i === m.sel} onPick={() => m.pick(c)} />
          ))}
        </div>
      )}
    </>
  );
}
