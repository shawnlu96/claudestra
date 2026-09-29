"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { AttachmentStrip } from "@/features/chat/components/attachments";
import { agentLabel, answerSummary, askAttachments, closedText, spanText, type WebAsk } from "../asks-model";
import { useAsks } from "../asks-store";
import { AskActions } from "./ask-actions";
import { AnswerImages } from "./assigned-choices";
import { ChatIcon, ClockIcon } from "./ask-icons";

/**
 * 一张「待你处理」卡（docs 13 §4.4，照 T12 原型右栏的卡）：谁在问、哪个任务、等了多久；标题；背景（owner「不知道上面发生了些什么」）；
 * 可展开原文；原消息带的附件；选项与文本框；回到对话（跳到原消息，ask-jump.ts）；还剩多久过期。已结案的只显示结论。
 */
export function AskCard({ ask, now, focused, onOpenChat }: { ask: WebAsk; now: number; focused: boolean; onOpenChat: (ask: WebAsk) => void }) {
  const t = useT();
  const [showBody, setShowBody] = useState(false);
  const note = useAsks().notes[ask.id];
  const open = ask.state === "open";
  const agent = agentLabel(ask.fromAgent, t, ask.kind);
  return (
    <article
      id={`ask-${ask.id}`}
      className={`rounded-xl border bg-base-100 p-3.5 shadow-sm ${focused ? "border-primary ring-2 ring-primary/30" : "border-base-content/10"} ${open ? "" : "opacity-70"}`}
    >
      <header className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">{agent}</span>
        {ask.taskId && <span className="rounded-full bg-base-content/10 px-2 py-0.5 opacity-80">{ask.taskId}</span>}
        {ask.urgency === "urgent" && open && <span className="rounded-full bg-error/15 px-2 py-0.5 text-error">{t("急")}</span>}
        {ask.kindHint === "authorize" && open && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{t("可能是授权")}</span>}
        <span className="ml-auto flex items-center gap-1 opacity-50">
          <ClockIcon />
          {open ? t("等了 {span}", { span: spanText(now - ask.createdAt, t) }) : closedText(ask, t)}
        </span>
      </header>
      <h3 className="text-[15px] font-semibold leading-snug">{ask.title}</h3>
      {ask.context && ask.context !== ask.title && <p className="mt-1 line-clamp-3 whitespace-pre-line text-[13px] opacity-75">{ask.context}</p>}
      {ask.body && ask.body !== ask.context && (
        <button type="button" className="mt-1 text-[12px] text-primary" onClick={() => setShowBody((v) => !v)}>
          {showBody ? t("收起原文") : t("看原文")}
        </button>
      )}
      {askAttachments(ask).length > 0 && (
        <div className="mt-2">
          <AttachmentStrip items={askAttachments(ask)} align="start" />
        </div>
      )}
      {showBody && <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-2.5 font-sans text-[12.5px]">{ask.body}</pre>}
      {ask.bind && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-[12px]">
          <div className="mb-1 font-medium text-warning">{t("批准的是：{action}", { action: ask.bind.version ? `${ask.bind.action} · ${ask.bind.version}` : ask.bind.action })}</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] opacity-85">{JSON.stringify(ask.bind.params, null, 2)}</pre>
        </div>
      )}

      {open && <AskActions ask={ask} agent={agent} />}
      {answerSummary(ask) && <p className="mt-2 text-[12.5px] opacity-75">{open ? t("已答：{s}", { s: answerSummary(ask) }) : answerSummary(ask)}</p>}
      <AnswerImages atts={ask.answer?.atts} />
      {note && <p className={`mt-2 text-[12.5px] ${note.ok ? "text-success" : "text-error"}`}>{note.text}</p>}

      <footer className="mt-3 flex items-center gap-2 text-[12px]">
        {ask.fromAgent && (
          <button type="button" className="btn btn-ghost btn-xs gap-1 px-1.5" onClick={() => onOpenChat(ask)}>
            <ChatIcon />
            {t("回到对话")}
          </button>
        )}
        {open && <span className="ml-auto opacity-45">{t("还剩 {span} 过期", { span: spanText(ask.expiresAt - now, t) })}</span>}
      </footer>
    </article>
  );
}
