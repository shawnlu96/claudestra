"use client";
import { useState } from "react";
import { dismissAskCard } from "@/lib/api/asks";
import { ApiError } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { AttachmentStrip } from "@/features/chat/components/attachments";
import { agentLabel, answerSummary, askAttachments, closedText, spanText, type WebAsk } from "../asks-model";
import { activeAnswered, clearAnswered, markAnswered } from "../answer-cooldown";
import { asksStore, useAsks } from "../asks-store";
import { AskActions } from "./ask-actions";
import { AnswerImages } from "./assigned-choices";
import { ChatIcon, ClockIcon, TrashIcon } from "./ask-icons";

/**
 * 一张「待你处理」卡（docs 13 §4.4，照 T12 原型右栏的卡）：谁在问、哪个任务、等了多久；标题；背景（owner「不知道上面发生了些什么」）；
 * 可展开原文；原消息带的附件；选项与文本框；回到对话（跳到原消息，ask-jump.ts）；还剩多久过期。已结案的只显示结论。
 */
/** leaving：刚答完、原位淡出中；guard：别的卡刚答完，这张短暂不收点击（answer-cooldown.ts） */
export function AskCard(props: { ask: WebAsk; now: number; focused: boolean; onOpenChat: (ask: WebAsk) => void; leaving?: boolean; guard?: boolean }) {
  const { ask, now, focused, onOpenChat, leaving, guard } = props;
  const t = useT();
  const [showBody, setShowBody] = useState(false);
  const { notes, full } = useAsks();
  const note = notes[ask.id];
  const open = ask.state === "open";
  const agent = agentLabel(ask.fromAgent, t, ask.kind);
  return (
    <article
      id={`ask-${ask.id}`}
      className={[
        "rounded-xl border bg-base-100 p-3.5 shadow-sm",
        focused ? "border-primary ring-2 ring-primary/30" : "border-base-content/10",
        open ? "" : "opacity-70",
        leaving ? "ask-card-out pointer-events-none" : guard ? "pointer-events-none" : "",
      ].join(" ")}
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
        {full && ask.canAnswer !== false && <DismissButton ask={ask} />}
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
      {!leaving && answerSummary(ask) && <p className="mt-2 text-[12.5px] opacity-75">{open ? t("已答：{s}", { s: answerSummary(ask) }) : answerSummary(ask)}</p>}
      <AnswerImages atts={ask.answer?.atts} />
      {!leaving && note && <p className={`mt-2 text-[12.5px] ${note.ok ? "text-success" : "text-error"}`}>{note.text}</p>}

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

/**
 * 右上角的删除（T61，离底部的作答按钮远，防误点）：只给读得了整本台账、能答这条的凭据（= owner 本人）。点了原位淡出，
 * 开着的撤销 / 运行时弹框只收起，已结案的从列表隐藏（bridge/ask-dismiss.ts）；失败回来并在卡上留原因
 */
function DismissButton({ ask }: { ask: WebAsk }) {
  const t = useT();
  const fail = (e: unknown) => (e instanceof ApiError ? (e.status === 409 ? t("这件已经处理过了（或已过期）") : e.message) : t("没发出去（连不上），再点一次"));
  const remove = async () => {
    if (activeAnswered()) return; // 过渡中不再提交（同作答）
    markAnswered(ask.id, ask);
    if (!(await asksStore.dismiss(ask.id, () => dismissAskCard(ask.project, ask.id), fail))) clearAnswered(ask.id);
  };
  return (
    <button type="button" aria-label={t("删除")} title={t("删除")} className="btn btn-ghost btn-xs btn-square -my-1 -mr-1 opacity-45 hover:opacity-100" onClick={() => void remove()}>
      <TrashIcon />
    </button>
  );
}
