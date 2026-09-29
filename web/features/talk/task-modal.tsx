"use client";
/**
 * 从 Chat 新建任务（一期只有 owner 能看到这个入口，bridge 也只认 owner）：选项目、填任务号和标题，勾选的原文记在任务上。
 * req 在打开弹窗时生成一次，连点 / 重试不会建出两条。
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { projectsList } from "@/lib/api/system";
import { createTask, type TalkRoom } from "@/lib/api/talk";
import { ResponsiveShell } from "@/features/chat/components/responsive-shell";
import { CloseIcon } from "./talk-icons";

const KINDS = ["code", "investigate", "ops"] as const;

export function TaskModal({ room, msgs, onClose }: { room: TalkRoom; msgs: string[]; onClose: (done: boolean) => void }) {
  const t = useT();
  const [projects, setProjects] = useState<{ id: string; name?: string }[]>([]);
  const [form, setForm] = useState({ project: "", id: "", title: "", kind: "code" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const req = useRef(`tt_${crypto.randomUUID()}`);

  useEffect(() => {
    projectsList<{ projects?: { id: string; name?: string }[] }>().then((r) => setProjects(r.projects ?? []), (e) => setError((e as Error).message));
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await createTask({ room: room.key, msgs, ...form, req: req.current });
      setMade(r.task.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ok = form.project && form.id.trim() && form.title.trim();
  return (
    <ResponsiveShell onClose={() => onClose(!!made)}>
      <header className="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 pb-3" style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}>
        <h2 className="flex-1 font-semibold">{t("用 {n} 条消息新建任务", { n: msgs.length })}</h2>
        <button className="btn btn-ghost btn-sm btn-square" aria-label={t("关闭")} onClick={() => onClose(!!made)}>
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {made ? (
          <p className="rounded-xl bg-success/10 p-4">{t("已建任务 {id}，勾选的原文记在任务上。", { id: made })}</p>
        ) : (
          <>
            <select className="select select-bordered select-sm w-full" value={form.project} onChange={set("project")}>
              <option value="" disabled>{t("选择项目")}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
            <div className="flex gap-2">
              <input className="input input-bordered input-sm w-28" placeholder={t("任务号，如 T123")} maxLength={32} value={form.id} onChange={set("id")} />
              <select className="select select-bordered select-sm" value={form.kind} onChange={set("kind")}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <input className="input input-bordered input-sm w-full" placeholder={t("任务标题")} maxLength={120} value={form.title} onChange={set("title")} />
            {error && <p className="text-sm text-error">{error}</p>}
          </>
        )}
      </div>
      {!made && (
        <footer className="flex shrink-0 justify-end gap-2 border-t border-base-300 px-4 pt-3" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => onClose(false)}>{t("取消")}</button>
          <button className="btn btn-primary btn-sm" disabled={!ok || busy} onClick={() => void go()}>{t("新建任务")}</button>
        </footer>
      )}
    </ResponsiveShell>
  );
}
