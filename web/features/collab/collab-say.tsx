"use client";
/**
 * 详情里的「对它说」。web 发的是人类消息：Claude Code 的 agent 忙时，bridge 会先 C-c 再投递（bridge.ts 的 preemptOnHumanMessage），
 * 等于打断它。所以第一版只在它空闲时能发，忙时按钮置灰、写明怎么办；「等这步做完再送达」的排队投递留给 T13a。
 * 能不能发的判定在 collab-action.ts 的 sayGate（有单测）。
 */
import { useRef, useState } from "react";
import { sendMessage } from "@/lib/api/chat";
import { sayGate } from "./collab-action";
import { Icon } from "./collab-icons";
import type { Tr } from "./collab-model";
import s from "./collab.module.css";

type Receipt = { kind: "sent"; at: number } | { kind: "error"; message: string } | null;

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function CollabSay({ agent, working, tr }: { agent: string; working: boolean; tr: Tr }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>(null);
  const ctrl = useRef<AbortController | null>(null);
  const gate = sayGate(working, text, sending);

  const send = async () => {
    if (!gate.canSend) return;
    setSending(true);
    ctrl.current = new AbortController();
    try {
      await sendMessage(agent, text.trim(), undefined, ctrl.current.signal);
      setText("");
      setReceipt({ kind: "sent", at: Date.now() });
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
          {gate.blockedByWork && <span className={s.sayHint}>{tr("它在干活。等它这步做完再说；要打断它，请到它的会话里说")}</span>}
          <button type="button" className={`${s.btn} ${s.pri}`} disabled={!gate.canSend} onClick={() => void send()}>
            <Icon name="send" size={13} />
            {tr("发送")}
          </button>
        </div>
      </div>
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
