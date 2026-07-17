"use client";
import { useState } from "react";
import { useChatStore } from "../chat-store";
import type { CcTaskView } from "../type";
import { useT } from "@/lib/i18n";

/**
 * Claude Code 原生任务清单面板(owner 2026-07-16:「console 里的 todo 适配到
 * Web UI」)。数据源 ~/.claude/tasks/<sessionId>/(经 bridge tasks 端点),
 * TaskCreate/TaskUpdate 工具出现时防抖刷新。
 *
 * 形态:消息列表尾部的折叠条——收起时「进度 + 当前进行中那句」,点开完整
 * 列表(完成灰勾 / 进行中蓝转 / 待办空心圆 / 被阻塞加 🔒)。无任务不渲染。
 */

function StatusIcon({ t }: { t: CcTaskView }) {
  if (t.status === "completed") {
    return (
      <svg className="size-3.5 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 12.5l2.5 2.5 5-5.5" />
      </svg>
    );
  }
  if (t.status === "in_progress") {
    return <span className="loading loading-spinner loading-xs shrink-0 text-info" />;
  }
  return (
    <svg className="size-3.5 shrink-0 text-base-content/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function CcTaskPanel() {
  const tr = useT(); // 译名用 tr——map 回调里 t 是任务变量
  const tasks = useChatStore((s) => s.state.ccTasks);
  const [open, setOpen] = useState(false);
  if (!tasks.length) return null;

  const done = tasks.filter((t) => t.status === "completed").length;
  const current = tasks.find((t) => t.status === "in_progress");
  const nextPending = tasks.find((t) => t.status === "pending");
  const headline = current
    ? current.activeForm || current.subject
    : nextPending
      ? `${tr("下一项:")}${nextPending.subject}`
      : tr("全部完成");

  return (
    <div className="chat-msg-in mb-[18px] overflow-hidden rounded-xl border border-base-content/10 bg-base-200/60">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="size-4 shrink-0 text-base-content/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="M4.5 5l1 1 2-2.2" />
          <path d="M4.5 11l1 1 2-2.2" />
          <circle cx="5.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
        </svg>
        <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-base-content/70">
          {tr("任务")} {done}/{tasks.length}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[11.5px] ${
            current ? "text-info" : "text-base-content/45"
          }`}
        >
          {current && <span className="loading loading-spinner loading-xs mr-1.5 align-[-2px]" />}
          {headline}
        </span>
        <svg
          className={`size-3.5 shrink-0 text-base-content/40 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul className="max-h-64 overflow-y-auto overscroll-contain border-t border-base-content/[0.06] px-3 py-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2 py-1">
              <span className="mt-0.5">
                <StatusIcon t={t} />
              </span>
              <span
                className={`min-w-0 flex-1 text-[12px] leading-snug ${
                  t.status === "completed"
                    ? "text-base-content/40 line-through decoration-base-content/20"
                    : t.status === "in_progress"
                      ? "font-medium text-base-content"
                      : "text-base-content/70"
                }`}
              >
                {t.subject}
                {t.blockedBy.length > 0 && t.status !== "completed" && (
                  <span className="ml-1.5 text-[10px] text-warning/80">🔒 {tr("待")} #{t.blockedBy.join(" #")}</span>
                )}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-base-content/25">#{t.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
