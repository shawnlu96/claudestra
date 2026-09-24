"use client";
import { useChatStore } from "../chat-store";
import { useT } from "@/lib/i18n";

/* 回合状态指示（从 message-list.tsx 原样搬出，D8-9）：正在回复 / 仍在工作 / 压缩中 /
   思考三点 / ✦ Claude 头 / 回合结束标记。 */

/** v2.20.2+「✍️ 正在回复…」——reply 工具调用已发出,回复马上到。 */
export function ReplyingLine() {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5 py-1.5 text-[12.5px] font-medium text-info">
      <span className="chat-dot inline-block size-1.5 rounded-full bg-info" />
      ✍️ {t("正在回复…")}
    </span>
  );
}

/**
 * v2.21.1+「仍在工作…」——reply 已经发出、但回合还没结束(owner 2026-09-02:
 * 「调完 reply 工具就当时完成了」)。与 ReplyingLine 区分:那条是「回复马上到」,
 * 这条是「回复给过了,我还在继续干」。done 事件到达才收场。
 */
export function WorkingLine() {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5 py-1.5 text-[12.5px] text-base-content/45">
      <span className="chat-dot inline-block size-1.5 rounded-full bg-base-content/40" />
      {t("仍在工作…")}
    </span>
  );
}

/**
 * v2.21.2+「📦 正在压缩上下文…」——agent 在 compact(手动 compact 发生在 Stop 之后,
 * 跑几分钟;此前这段时间 UI 一直是「已完成」,owner 2026-09-02 报)。compact_done /
 * 随后的 done·running 状态事件收场。
 */
export function CompactingLine() {
  const t = useT();
  const pct = useChatStore((s) => s.state.compactPct);
  return (
    <span className="inline-flex items-center gap-1.5 py-1.5 text-[12.5px] font-medium text-info">
      <span className="chat-dot inline-block size-1.5 rounded-full bg-info" />
      📦 {t("正在压缩上下文…")}
      {pct !== null && <span className="font-mono tabular-nums opacity-70">{pct}%</span>}
    </span>
  );
}

/** 流式「思考中」三点。 */
export function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 py-1.5">
      {[0, 0.2, 0.4].map((d) => (
        <span
          key={d}
          className="chat-dot size-1.5 rounded-full bg-base-content/45"
          style={{ animationDelay: `${d}s` }}
        />
      ))}
    </span>
  );
}

/** ✦ Claude 头（assistant 消息 / 独立思考态共用）。头像/名称可在设置里
 *  自定义(owner 2026-07-14),未设置回落 ✦ + Claude。pulsing = 思考中缓慢
 *  呼吸(owner 2026-07-16 动效)。 */
export function ClaudeHeader({ pulsing = false }: { pulsing?: boolean }) {
  const profile = useChatStore((s) => s.state.profile);
  const pulse = pulsing ? "claude-pulse" : "";
  return (
    <div className="mb-[9px] flex items-center gap-2">
      {profile.claudeAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={profile.claudeAvatar} alt="" className={`size-[22px] rounded-full object-cover ${pulse}`} />
      ) : (
        <span className={`flex size-[22px] items-center justify-center rounded-full bg-accent text-[11px] text-white ${pulse}`}>
          ✦
        </span>
      )}
      <span className="text-xs font-semibold text-base-content/60">
        {profile.claudeNickname || "Claude"}
      </span>
    </div>
  );
}

/** 回合结束标记:居中分隔线样式(owner 2026-07-14:「像中段一样居中、横线
 *  隔开、带颜色和 tick 图标」),三态同构:绿=完成 / 黄=已打断 / 红=出错。
 *  横线用 currentColor 低透明度,自动跟随态色。 */
export function TurnMark({ kind, ms, animate = true }: { kind: "done" | "interrupted" | "error" | "bg"; ms?: number; animate?: boolean }) {
  const t = useT();
  const conf = {
    done: { cls: "text-success", label: "完成", icon: <path d="M8.5 12.5l2.5 2.5 5-5.5" /> },
    interrupted: { cls: "text-warning", label: "已打断", icon: <path d="M5.6 5.6l12.8 12.8" /> },
    error: { cls: "text-error", label: "出错", icon: <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /> },
    // v2.20.2+ 回合结束但后台任务还在跑——不是「完成」,别给绿勾(owner 实报误导)
    bg: { cls: "text-info", label: "后台任务继续中", icon: <path d="M12 7v5l3.5 2" /> },
  }[kind];
  return (
    <div className={`${animate ? "chat-msg-in" : ""} my-3.5 flex select-none items-center gap-3 ${conf.cls}`}>
      <span className="h-px flex-1 bg-current opacity-20" />
      <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          {conf.icon}
        </svg>
        {t(conf.label)}
        {kind === "done" && typeof ms === "number" && (
          <span className="font-mono text-[10.5px] font-normal tabular-nums opacity-70">
            · {(ms / 1000).toFixed(ms >= 60_000 ? 0 : 1)}s
          </span>
        )}
      </span>
      <span className="h-px flex-1 bg-current opacity-20" />
    </div>
  );
}
