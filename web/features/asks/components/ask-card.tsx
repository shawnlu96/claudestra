"use client";
import { useState } from "react";
import { answerAskCard } from "@/lib/api/asks";
import { answerAuq, answerPermission } from "@/lib/api/chat";
import { ApiError } from "@/lib/api/client";
import { uiAgentName } from "@/lib/chat/agents";
import type { WebComponentRow } from "@/lib/chat/events";
import { useT } from "@/lib/i18n";
import { answerSummary, closedText, spanText, type WebAsk } from "../asks-model";
import { asksStore } from "../asks-store";
import { AuqChoices, PermissionChoices, ReplyChoices } from "./ask-choices";
import { ChatIcon, ClockIcon, TerminalIcon } from "./ask-icons";

/**
 * 一张「待你处理」卡（docs 13 §4.4，照 T12 原型右栏的卡）：谁在问、哪个任务、等了多久；标题；背景（owner「不知道上面发生了些什么」）；
 * 可展开原文；选项与文本框；回到对话；还剩多久过期。已结案的只显示结论。
 */
export function AskCard({ ask, now, focused, onOpenChat }: { ask: WebAsk; now: number; focused: boolean; onOpenChat: (agent: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [showBody, setShowBody] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const open = ask.state === "open";
  const agent = uiAgentName(ask.fromAgent);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: t("已发给 {agent}，它忙完手上这一步就会看到", { agent }) });
    } catch (e) {
      const closed = e instanceof ApiError && e.status === 409;
      setNote({ ok: false, text: closed ? t("这件已经处理过了（或已过期）") : (e as Error).message });
    }
    setBusy(false);
    void asksStore.refresh();
  };
  const rows = ask.options as WebComponentRow[];

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
      {showBody && <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-base-200 p-2.5 font-sans text-[12.5px]">{ask.body}</pre>}

      {open && (
        <div className="mt-3">
          {ask.source === "reply" && (
            <ReplyChoices rows={rows} allowText={ask.allowText} busy={busy} onAnswer={(choices, text) => run(() => answerAskCard(ask.project, ask.id, choices, text))} />
          )}
          {ask.source === "auq" && (
            <AuqChoices
              questions={ask.options as never[]}
              busy={busy}
              onSubmit={(sel) => run(() => answerAuq(ask.fromAgent, "submit", sel))}
              onCancel={() => run(() => answerAuq(ask.fromAgent, "cancel"))}
            />
          )}
          {ask.source === "permission" && <PermissionChoices rows={rows} busy={busy} onPick={(a) => run(() => answerPermission(ask.fromAgent, a))} />}
          {ask.source === "codex" && (
            <p className="flex items-center gap-1.5 text-[13px] opacity-75">
              <TerminalIcon />
              {t("这个弹框要到终端里处理")}
            </p>
          )}
        </div>
      )}
      {!open && answerSummary(ask) && <p className="mt-2 text-[12.5px] opacity-75">{answerSummary(ask)}</p>}
      {note && <p className={`mt-2 text-[12.5px] ${note.ok ? "text-success" : "text-error"}`}>{note.text}</p>}

      <footer className="mt-3 flex items-center gap-2 text-[12px]">
        <button type="button" className="btn btn-ghost btn-xs gap-1 px-1.5" onClick={() => onOpenChat(ask.fromAgent)}>
          <ChatIcon />
          {t("回到对话")}
        </button>
        {open && <span className="ml-auto opacity-45">{t("还剩 {span} 过期", { span: spanText(ask.expiresAt - now, t) })}</span>}
      </footer>
    </article>
  );
}
