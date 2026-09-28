"use client";
/**
 * 详情里的「对它说」。第一版只有「等这步做完」：走普通的 POST /agents/:name/messages——
 * agent 忙时 bridge 押后、回合边界送达，闲时直接送达；「立即打断」要 T13a 的投递语义，先灰着。
 * 回执只按发送那一刻的 busy 说「排队中」还是「已送达」，不假装知道它读没读。
 */
import { useRef, useState } from "react";
import { sendMessage } from "@/lib/api/chat";
import { Icon } from "./collab-icons";
import type { Tr } from "./collab-model";
import s from "./collab.module.css";

type Receipt = { kind: "queued" | "sent"; at: number } | { kind: "error"; message: string } | null;

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function CollabSay({ agent, busy, tr }: { agent: string; busy: boolean; tr: Tr }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>(null);
  const ctrl = useRef<AbortController | null>(null);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    ctrl.current = new AbortController();
    try {
      await sendMessage(agent, body, undefined, ctrl.current.signal);
      setText("");
      setReceipt({ kind: busy ? "queued" : "sent", at: Date.now() });
    } catch (e) {
      setReceipt({ kind: "error", message: (e as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <div className={s.say}>
        <textarea
          value={text}
          placeholder={tr("比如：先别动 chat.tsx，等 T4 合并后 rebase")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <div className={s.bar}>
          <div className={s.seg}>
            <button type="button" className={s.on}>{tr("等这步做完")}</button>
            <button type="button" disabled title={tr("下一版支持")}>{tr("立即打断")}</button>
          </div>
          <button type="button" className={`${s.btn} ${s.pri}`} disabled={!text.trim() || sending} onClick={() => void send()}>
            <Icon name="send" size={13} />
            {tr("发送")}
          </button>
        </div>
      </div>
      {receipt?.kind === "queued" && (
        <div className={s.rcpt}>
          <Icon name="hourglass" size={12} />
          {tr("排队中 · {t}，它这步做完后送达", { t: hhmm(receipt.at) })}
        </div>
      )}
      {receipt?.kind === "sent" && (
        <div className={`${s.rcpt} ${s.ok}`}>
          <Icon name="circleCheck" size={12} />
          {tr("已送达 · {t}", { t: hhmm(receipt.at) })}
        </div>
      )}
      {receipt?.kind === "error" && <div className={`${s.rcpt} ${s.err}`}>{tr("没发出去：{m}", { m: receipt.message })}</div>}
    </div>
  );
}
