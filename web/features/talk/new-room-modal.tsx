"use client";
/**
 * 开一个新对话：选一个人 = 私聊（dm）；owner 选多个人加标题 = 小组（thread）。guest 只看得到 owner，只能和 owner 私聊。
 * owner 在这里还能给人设本机备注名、把同一个人的另一台 guest 设备并进来（合并后两台设备看到的是同一个人的对话）。
 */
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { mergePerson, openDm, openThread, renamePerson, unmergePerson, type TalkPerson, type TalkRoom } from "@/lib/api/talk";
import { ResponsiveShell } from "@/features/chat/components/responsive-shell";
import { CloseIcon } from "./talk-icons";
import type { TalkMe } from "./use-talk";

function PersonTools({ p, people, onChanged }: { p: TalkPerson; people: TalkPerson[]; onChanged: () => void }) {
  const t = useT();
  const [name, setName] = useState<string | null>(null);
  const run = (f: () => Promise<unknown>) => void f().then(onChanged, (e) => window.alert((e as Error).message));
  const guests = people.filter((x) => !x.isOwner && x.id !== p.id && !x.mergedInto);
  if (name !== null) {
    return (
      <form className="flex gap-1" onSubmit={(e) => (e.preventDefault(), run(() => renamePerson(p.id, name)), setName(null))}>
        <input className="input input-bordered input-xs w-28" value={name} maxLength={32} autoFocus onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-xs">{t("保存")}</button>
      </form>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button className="btn btn-ghost btn-xs" onClick={() => setName(p.name)}>{t("改名")}</button>
      {!p.isOwner && (p.mergedInto ? (
        <button className="btn btn-ghost btn-xs" onClick={() => run(() => unmergePerson(p.id))}>{t("拆开")}</button>
      ) : guests.length > 0 && (
        <select className="select select-ghost select-xs" value="" onChange={(e) => e.target.value && run(() => mergePerson(p.id, e.target.value))} aria-label={t("并入")}>
          <option value="">{t("并入…")}</option>
          {guests.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      ))}
    </span>
  );
}

export function NewRoomModal({ me, people, onClose, onOpened, onPeopleChanged }: {
  me: TalkMe; people: TalkPerson[]; onClose: () => void; onOpened: (room: TalkRoom) => void; onPeopleChanged: () => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = people.filter((p) => p.id !== me.id && !p.disabled && !p.mergedInto);
  const merged = people.filter((p) => p.mergedInto);

  const go = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = picked.length === 1 ? await openDm(picked[0]) : await openThread(picked, title);
      onOpened(r.room);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : me.isOwner ? [...xs, id] : [id]));
  return (
    <ResponsiveShell onClose={onClose}>
      <header className="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 pb-3" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
        <h2 className="flex-1 font-semibold">{t("新对话")}</h2>
        <button className="btn btn-ghost btn-sm btn-square" aria-label={t("关闭")} onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-2 text-sm text-base-content/60">{me.isOwner ? t("选一个人私聊，选几个人开小组。") : t("你可以和 owner 私聊。")}</p>
        {others.length === 0 && <p className="text-sm text-base-content/50">{t("这台机器上还没有别的人。先在设置里配对一台 guest 设备。")}</p>}
        <ul className="space-y-1">
          {others.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-base-200">
              <label className="flex flex-1 cursor-pointer items-center gap-2">
                <input type={me.isOwner ? "checkbox" : "radio"} className={me.isOwner ? "checkbox checkbox-sm" : "radio radio-sm"} checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                <span className="truncate">{p.name}</span>
                {p.isOwner && <span className="badge badge-ghost badge-sm">owner</span>}
              </label>
              {me.isOwner && <PersonTools p={p} people={people} onChanged={onPeopleChanged} />}
            </li>
          ))}
        </ul>
        {me.isOwner && merged.length > 0 && (
          <div className="mt-4">
            <p className="mb-1 text-xs text-base-content/50">{t("已并入别人的设备")}</p>
            <ul className="space-y-1">
              {merged.map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-2 text-sm text-base-content/60">
                  <span className="flex-1 truncate">{p.name} → {people.find((x) => x.id === p.mergedInto)?.name ?? p.mergedInto}</span>
                  <PersonTools p={p} people={people} onChanged={onPeopleChanged} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {picked.length > 1 && (
          <input className="input input-bordered input-sm mt-3 w-full" placeholder={t("小组名（可选）")} maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
        )}
        {error && <p className="mt-2 text-sm text-error">{error}</p>}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-base-300 px-4 pt-3" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>{t("取消")}</button>
        <button className="btn btn-primary btn-sm" disabled={!picked.length || busy} onClick={() => void go()}>
          {picked.length > 1 ? t("开小组") : t("开始私聊")}
        </button>
      </footer>
    </ResponsiveShell>
  );
}
