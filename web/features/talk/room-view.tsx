"use client";
/**
 * 一个 Chat 房间：消息列表 + 输入框。点「选择」进入勾选模式，勾几条后「丢进工作台」（drop-modal.tsx）——
 * 这是 Chat 内容进 agent 上下文的唯一入口；平时发的消息、@ 都不会发给任何 agent。换房间时按房间键重挂（勾选状态随之清空）。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { AuthImg } from "@/features/chat/components/auth-img";
import { attUrl, deleteMessage, type TalkMessage, type TalkRoom } from "@/lib/api/talk";
import { DropModal } from "./drop-modal";
import { BackIcon, DropIcon, SelectIcon, TrashIcon } from "./talk-icons";
import type { TalkMe } from "./use-talk";

const pad = (n: number) => String(n).padStart(2, "0");
function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const REF_LABEL: Record<string, string> = { message: "工作台消息", task: "任务", ask: "待处理", doc: "文档" };

function Bubble({ m, room, me, selecting, checked, onToggle, onDeleted }: {
  m: TalkMessage; room: TalkRoom; me: TalkMe; selecting: boolean; checked: boolean; onToggle: () => void; onDeleted: () => void;
}) {
  const t = useT();
  const canDelete = !m.deletedAt && (m.mine || me.isOwner);
  const bubble = m.mine ? "bg-primary text-primary-content" : "bg-base-100 text-base-content border border-base-300";
  return (
    <div className={`group flex gap-2 px-3 py-1 ${m.mine ? "flex-row-reverse" : ""}`} data-talk-msg={m.key}>
      {selecting && !m.deletedAt && (
        <input type="checkbox" className="checkbox checkbox-sm mt-2 shrink-0" checked={checked} onChange={onToggle} aria-label={t("选择这条")} />
      )}
      <div className={`flex max-w-[78%] flex-col ${m.mine ? "items-end" : "items-start"}`}>
        {!m.mine && room.kind === "thread" && <span className="mb-0.5 px-1 text-xs text-base-content/60">{m.author.name}</span>}
        <div className={`rounded-2xl px-3 py-2 text-[15px] leading-relaxed ${m.deletedAt ? "bg-base-200 italic text-base-content/50" : bubble}`}>
          {m.deletedAt ? t("（已删除）") : (
            <>
              {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
              {m.atts.length > 0 && (
                <div className={`flex flex-wrap gap-1.5 ${m.text ? "mt-1.5" : ""}`}>
                  {m.atts.map((a) => <AuthImg key={a.sha256} src={attUrl(a.sha256)} alt="" className="max-h-60 max-w-[14rem] rounded-lg object-cover" />)}
                </div>
              )}
              {m.refs.map((r) => (
                <div key={`${r.kind}:${r.id}`} className="mt-1.5 rounded-lg bg-base-200/70 px-2 py-1 text-xs text-base-content">
                  {t(REF_LABEL[r.kind] ?? r.kind)}：{r.title}
                  {!r.open && <span className="ml-1 text-base-content/50">{t("（你没有权限打开）")}</span>}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 px-1 text-[11px] text-base-content/45">
          <span>{when(m.createdAt)}</span>
          {canDelete && !selecting && (
            <button
              className="opacity-0 transition-opacity hover:text-error group-hover:opacity-100 max-sm:opacity-100"
              aria-label={t("删除")}
              onClick={() => {
                if (!window.confirm(t("删除这条消息？只删本机这份。"))) return;
                void deleteMessage(room.key, m).then(onDeleted, (e) => window.alert((e as Error).message));
              }}
            >
              <TrashIcon size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function RoomView({ room, me, messages, loading, onBack, onChanged, composer }: {
  room: TalkRoom; me: TalkMe; messages: TalkMessage[]; loading: boolean; onBack: () => void; onChanged: () => void; composer: React.ReactNode;
}) {
  const t = useT();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = messages[messages.length - 1]?.key;

  // 新消息到了贴底（只在最后一条变了时，翻看历史不被拽走）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastKey]);

  const toggle = (key: string) => setPicked((xs) => (xs.includes(key) ? xs.filter((x) => x !== key) : [...xs, key]));
  const others = room.members.filter((m) => m.id !== me.id).map((m) => m.name).join("、");

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-base-200/40">
      <header className="flex shrink-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}>
        <button className="btn btn-ghost btn-sm btn-square sm:hidden" aria-label={t("返回")} onClick={onBack}>
          <BackIcon size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{room.title}</div>
          <div className="truncate text-xs text-base-content/55">{room.kind === "thread" ? others : t("私聊 · 不烧 token")}</div>
        </div>
        <button
          className={`btn btn-sm ${selecting ? "btn-primary" : "btn-ghost"}`}
          onClick={() => (selecting ? (setSelecting(false), setPicked([])) : setSelecting(true))}
          title={t("勾选几条消息丢进工作台")}
        >
          <SelectIcon size={16} />
          <span className="max-sm:hidden">{selecting ? t("取消选择") : t("选择")}</span>
        </button>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {loading && !messages.length && <p className="p-6 text-center text-sm text-base-content/50">{t("加载中…")}</p>}
        {!loading && !messages.length && <p className="p-6 text-center text-sm text-base-content/50">{t("还没有消息。这里的对话只在人和人之间，不会发给任何 agent。")}</p>}
        {messages.map((m) => (
          <Bubble key={m.key} m={m} room={room} me={me} selecting={selecting} checked={picked.includes(m.key)} onToggle={() => toggle(m.key)} onDeleted={onChanged} />
        ))}
      </div>
      {selecting ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-base-300 bg-base-100 px-3 pt-2" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}>
          <span className="flex-1 text-sm text-base-content/70">{t("已选 {n} 条", { n: picked.length })}</span>
          <button className="btn btn-primary btn-sm" disabled={!picked.length} onClick={() => setDropping(true)}>
            <DropIcon size={16} />
            {t("丢进工作台")}
          </button>
        </div>
      ) : (
        composer
      )}
      {dropping && (
        <DropModal
          room={room}
          msgs={messages.filter((m) => picked.includes(m.key)).map((m) => m.key)}
          onClose={(done) => {
            setDropping(false);
            if (done) {
              setSelecting(false);
              setPicked([]);
            }
          }}
        />
      )}
    </section>
  );
}
