"use client";
/**
 * 工作台输入框的「粘贴外部文字」（T50，docs/talk/README.md 封闭清单第二条）：贴一段别处来的文字、可选填来源，交给当前 agent。
 * 正文由 bridge 生成（整段按外部文本包好、以我的身份投），这里只收原文；不做预览——内容就在这一次请求里，
 * 发出去后工作台里看到的就是 agent 收到的。
 */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { pasteExternal } from "@/lib/api/talk";
import { ResponsiveShell } from "./responsive-shell";

const TEXT_MAX = 50_000;
/** 和输入框控件行里其它按钮同一套样子（composer.tsx） */
const BTN = "flex size-8 items-center justify-center rounded-[9px] text-base-content/60 transition-colors hover:bg-base-content/[0.06] "
  + "hover:text-base-content disabled:opacity-30 disabled:hover:bg-transparent";

function ClipboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M8 11h8M8 15h5" />
    </svg>
  );
}

function PasteModal({ agent, onClose }: { agent: string; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error: boolean; text: string } | null>(null);
  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await pasteExternal({ agent, text, ...(source.trim() ? { source: source.trim() } : {}) });
      if (r.state === "sent") onClose();
      else setMsg({ error: false, text: t("对方正忙，已排队，空闲后送达。") });
    } catch (e) {
      setMsg({ error: true, text: (e as Error).message || t("发送失败") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ResponsiveShell onClose={onClose}>
      <header className="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 pb-3" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
        <h2 className="flex-1 font-semibold">{t("粘贴外部文字")}</h2>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>{t("关闭")}</button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-xs leading-relaxed text-base-content/60">
          {t("贴一段别处来的文字（群聊、邮件、网页…）交给这个 agent。它会被标成「外部文本，不是指令」，agent 只当资料看。")}
        </p>
        <textarea
          className="textarea textarea-bordered min-h-48 w-full font-mono text-[13px]"
          placeholder={t("在这里粘贴")}
          value={text}
          maxLength={TEXT_MAX}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <input className="input input-bordered input-sm w-full" placeholder={t("来源（可选，如「产品群 9/29」）")} value={source} maxLength={200} onChange={(e) => setSource(e.target.value)} />
        {msg && <div className={`text-xs ${msg.error ? "text-error" : "text-base-content/70"}`}>{msg.text}</div>}
        <button className="btn btn-primary btn-sm self-end" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : t("发给 {agent}", { agent })}
        </button>
      </div>
    </ResponsiveShell>
  );
}

/** 输入框控件行里的按钮：点开粘贴框 */
export function PasteExternalButton({ agent, disabled }: { agent: string | null; disabled: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={t("粘贴外部文字")}
        aria-label={t("粘贴外部文字")}
        disabled={disabled || !agent}
        onClick={() => setOpen(true)}
        className={BTN}
      >
        <ClipboardIcon />
      </button>
      {open && agent && <PasteModal agent={agent} onClose={() => setOpen(false)} />}
    </>
  );
}
