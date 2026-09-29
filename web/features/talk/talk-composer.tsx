"use client";
/**
 * Chat 的输入框：文字、图片（png / jpeg / webp，bridge 剥元数据后按内容存）、@ 房间里的人。
 * @ 结构化存 person id：点 @ 按钮选人插入「@名字 」，发送时只带正文里仍然出现的那些。Enter 发送，Shift+Enter 换行，输入法组字中不发。
 */
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { postMessage, type TalkPerson } from "@/lib/api/talk";
import { IMAGE_ACCEPT, PendingStrip, usePendingImages } from "./pending-images";
import { AtIcon, ImageIcon, SendIcon } from "./talk-icons";

export function TalkComposer({ roomKey, members, meId, onSent }: { roomKey: string; members: TalkPerson[]; meId: string; onSent: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<TalkPerson[]>([]);
  const imgs = usePendingImages();
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const others = members.filter((m) => m.id !== meId);

  const mention = (p: TalkPerson) => {
    setPicker(false);
    setPicked((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p]));
    setText((s) => `${s}${s && !s.endsWith(" ") ? " " : ""}@${p.name} `);
    areaRef.current?.focus();
  };

  const send = async () => {
    const body = text.trim();
    const shas = imgs.uploaded.map((a) => a.sha256);
    if (busy || !imgs.ready || (!body && !shas.length)) return;
    setBusy(true);
    setError(null);
    try {
      const mentions = picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id);
      await postMessage(roomKey, { id: `tm_${crypto.randomUUID()}`, text: body, atts: shas, mentions });
      setText("");
      setPicked([]);
      imgs.clear();
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-base-300 bg-base-100 px-3 pt-2" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}>
      <PendingStrip atts={imgs.atts} onRemove={imgs.remove} />
      {error && <p className="mb-1 text-xs text-error">{t("没发出去：{e}", { e: error })}</p>}
      <div className="relative flex items-end gap-1.5">
        <button className="btn btn-ghost btn-sm btn-square" aria-label={t("发图片")} title={t("发图片")} onClick={() => fileRef.current?.click()}>
          <ImageIcon size={18} />
        </button>
        <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={(e) => (imgs.add(e.target.files), (e.target.value = ""))} />
        {others.length > 0 && (
          <button className="btn btn-ghost btn-sm btn-square" aria-label={t("@ 某人")} title={t("@ 某人")} onClick={() => setPicker((v) => !v)}>
            <AtIcon size={18} />
          </button>
        )}
        {picker && <MentionPicker people={others} onPick={mention} />}
        <textarea
          ref={areaRef}
          className="textarea textarea-bordered min-h-[2.5rem] flex-1 resize-none text-[15px] leading-snug"
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          placeholder={t("发给房间里的人（不会发给 agent）")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary btn-sm btn-square" aria-label={t("发送")} disabled={busy || !imgs.ready || (!text.trim() && !imgs.uploaded.length)} onClick={() => void send()}>
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  );
}

function MentionPicker({ people, onPick }: { people: TalkPerson[]; onPick: (p: TalkPerson) => void }) {
  return (
    <ul className="menu absolute bottom-11 left-8 z-20 w-48 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
      {people.map((p) => (
        <li key={p.id}>
          <button onClick={() => onPick(p)}>{p.name}</button>
        </li>
      ))}
    </ul>
  );
}
