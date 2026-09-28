"use client";
/**
 * Chat 页（/talk）：左边房间列表，右边当前房间；窄屏一次只显示一边。人与人的对话不烧 token——
 * 只有勾选后「丢进工作台」才会交给 agent。侧栏顶部的「工作台 | Chat」和 /chat 共用同一个切换组件。
 * 壳子照 /chat 的 PWA 不变式：根 fixed inset-0 overflow-hidden，安全区由各面板自己垫。
 */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { NewRoomModal } from "./new-room-modal";
import { RoomView } from "./room-view";
import { TalkComposer } from "./talk-composer";
import { PlusIcon } from "./talk-icons";
import { useMachineFp, useTalk } from "./use-talk";
import { WorkspaceSwitch } from "./workspace-switch";

const pad = (n: number) => String(n).padStart(2, "0");
const short = (ts: number) => {
  const d = new Date(ts);
  return new Date().toDateString() === d.toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
};

/** 切机器 = 按新 fp 重挂整页（房间、目录、事件流都属于上一台机器） */
export function TalkApp() {
  const fp = useMachineFp();
  return <TalkPage key={fp ?? "none"} />;
}

function TalkPage() {
  const t = useT();
  const s = useTalk();
  const [creating, setCreating] = useState(false);

  const list = (
    <aside className={`flex min-h-0 w-full shrink-0 flex-col border-r border-base-300 bg-base-200 sm:w-72 ${s.active ? "max-sm:hidden" : ""}`}>
      <div className="flex items-center gap-2 px-4 pb-2.5" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
        <WorkspaceSwitch active="talk" />
        <span className="flex-1" />
        {s.me && (
          <button className="flex h-7 items-center rounded-lg px-1.5 text-base-content/60 hover:bg-base-300 hover:text-base-content" title={t("新对话")} aria-label={t("新对话")} onClick={() => setCreating(true)}>
            <PlusIcon size={18} />
          </button>
        )}
      </div>
      <p className="px-4 pb-2 text-xs text-base-content/50">{t("人和人之间的对话，不烧 token。")}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {s.denied && <p className="p-3 text-sm text-base-content/60">{t("这台设备不能用 Chat（只给本机 owner 和 guest 设备）。")}</p>}
        {s.me && !s.rooms.length && <p className="p-3 text-sm text-base-content/50">{t("还没有对话。点右上角 + 开一个。")}</p>}
        {s.rooms.map((r) => (
          <button
            key={r.key}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${r.key === s.active ? "bg-base-300" : "hover:bg-base-300/60"}`}
            onClick={() => s.setActive(r.key)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px]">{r.title}</span>
              <span className="block truncate text-xs text-base-content/50">{r.kind === "thread" ? t("小组 · {n} 人", { n: r.members.length }) : t("私聊")}</span>
            </span>
            <span className="shrink-0 text-[11px] text-base-content/40">{short(r.lastAt)}</span>
          </button>
        ))}
      </div>
    </aside>
  );

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-base-100">
      {list}
      {s.me && s.room ? (
        <RoomView
          key={s.room.key}
          room={s.room}
          me={s.me}
          messages={s.messages}
          loading={s.loadingRoom}
          onBack={() => s.setActive(null)}
          onChanged={() => void s.reloadRoom(s.room!.key)}
          composer={<TalkComposer roomKey={s.room.key} members={s.room.members} meId={s.me.id} onSent={() => void s.reloadRoom(s.room!.key)} />}
        />
      ) : (
        <section className="hidden flex-1 items-center justify-center text-sm text-base-content/50 sm:flex">
          {t("选择左侧一个对话，或点 + 开一个。")}
        </section>
      )}
      {creating && s.me && (
        <NewRoomModal
          me={s.me}
          people={s.people}
          onClose={() => setCreating(false)}
          onPeopleChanged={() => void s.reloadList()}
          onOpened={(room) => {
            setCreating(false);
            void s.reloadList().then(() => s.setActive(room.key));
          }}
        />
      )}
    </div>
  );
}
