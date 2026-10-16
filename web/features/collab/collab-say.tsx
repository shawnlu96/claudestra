"use client";
/** Collab sends request calm delivery explicitly; the bridge owns busy checks and the existing held queue. */
import { useRef, useState } from "react";
import { getSettings } from "@/lib/api/settings";
import { useSettingsFlag } from "@/features/chat/components/settings/settings-flag";
import { sendMessage } from "@/lib/api/chat";
import { agentPending } from "@/lib/api/ledger";
import { liveIdle, sayGate } from "./collab-action";
import { Icon } from "./collab-icons";
import type { Tr } from "./collab-model";
import s from "./collab.module.css";

type Receipt = { kind: "queued" } | { kind: "sent"; at: number } | { kind: "busy" } | { kind: "unknown" } | { kind: "error"; message: string } | null;

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function CollabSay({ agent, working, tr }: { agent: string; working: boolean; tr: Tr }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt>(null);
  const ctrl = useRef<AbortController | null>(null);
  const flag = useSettingsFlag("steer.queueWhenBusy");
  const inFlight = useRef(false);
  const gate = sayGate(working, text, sending || flag.on === null, flag.on === true);

  const send = async () => {
    if (!gate.canSend || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    ctrl.current = new AbortController();
    try {
      const queueWhenBusy = (await getSettings())["steer.queueWhenBusy"];
      if (!queueWhenBusy) {
        const pending = await agentPending(agent);
        if (!liveIdle(pending)) {
          setReceipt({ kind: pending === null ? "unknown" : "busy" });
          return;
        }
      }
      const result = await sendMessage(agent, text.trim(), undefined, ctrl.current.signal, { waitForIdle: queueWhenBusy });
      setText("");
      setReceipt(result.queued || result.heldBy ? { kind: "queued" }
        : result.guarded ? { kind: "error", message: tr("等待放行") } : { kind: "sent", at: Date.now() });
    } catch (e) {
      setReceipt({ kind: "error", message: (e as Error).message });
    } finally {
      inFlight.current = false;
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
      {flag.err && <div className={`${s.rcpt} ${s.err}`}>{flag.err}</div>}
      {receipt?.kind === "queued" && <div className={s.rcpt}>{tr("排队中")}</div>}
      {receipt?.kind === "sent" && (
        <div className={`${s.rcpt} ${s.ok}`}>
          <Icon name="circleCheck" size={12} />
          {tr("已送达 · {t}", { t: hhmm(receipt.at) })}
        </div>
      )}
      {receipt?.kind === "busy" && <div className={`${s.rcpt} ${s.err}`}>{tr("它刚开始干活，没发。等它这步做完再说")}</div>}
      {receipt?.kind === "unknown" && <div className={`${s.rcpt} ${s.err}`}>{tr("没查到它的状态，没发")}</div>}
      {receipt?.kind === "error" && <div className={`${s.rcpt} ${s.err}`}>{tr("没发出去：{m}", { m: receipt.message })}</div>}
    </div>
  );
}
