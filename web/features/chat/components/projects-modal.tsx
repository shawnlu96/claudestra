"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";
import { useChatStoreApi } from "../chat-store";
import type { ProjectMeta } from "../type";

/**
 * v2.21+ 项目管理弹窗(侧栏 📁 进入;owner 2026-08-28「project 概念 + UI 方便管理」)。
 * 列表 + 行内编辑(名/emoji/目录/说明) + 成员转移 + 新建 + 删除(须先清空成员)。
 * 数据面走 /api/projects(BFF)→ bridge /api/v1/projects → runManager project-*,
 * 与 CLI 等价。agent 归属是硬约束——成员只能「转移到别的 project」,不能移出不管。
 */

async function projAction(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> {
  try {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 单个 project 行:折叠态概览,展开态编辑 + 成员管理。 */
function ProjectRow({
  proj,
  all,
  onChanged,
}: {
  proj: ProjectMeta;
  all: ProjectMeta[];
  onChanged: () => void;
}) {
  const t = useT();
  const [expand, setExpand] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [name, setName] = useState(proj.name);
  const [emoji, setEmoji] = useState(proj.emoji || "");
  const [desc, setDesc] = useState(proj.description || "");
  const [dirsText, setDirsText] = useState(proj.dirs.join("\n"));
  const [confirmDel, setConfirmDel] = useState(false);

  const members = proj.agents || [];
  const others = all.filter((p) => p.id !== proj.id);

  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg("");
    const r = await projAction(body);
    if (!r.ok) setMsg(r.error || t("操作失败"));
    setBusy(false);
    onChanged();
    return !!r.ok;
  };

  const dirty =
    name.trim() !== proj.name ||
    emoji.trim() !== (proj.emoji || "") ||
    desc.trim() !== (proj.description || "") ||
    dirsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n") !== proj.dirs.join("\n");

  return (
    <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-3">
      <button type="button" className="w-full text-left" onClick={() => setExpand((v) => !v)}>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[15px]">{proj.emoji || "📁"}</span>
          <span className="truncate text-[13.5px] font-semibold">{proj.name}</span>
          <code className="shrink-0 rounded bg-base-content/10 px-1.5 py-0.5 text-[11px]">{proj.id}</code>
          <span className="ml-auto shrink-0 text-[11px] opacity-50">
            {members.length} {t("个 agent")}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-base-content/50">
          {proj.dirs.join(" · ")}
        </div>
      </button>

      {expand && (
        <div className="mt-3 space-y-2 border-t border-base-content/10 pt-3">
          <div className="flex gap-2">
            <input
              className="input input-sm input-bordered w-14 text-center"
              placeholder="📁"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
            />
            <input
              className="input input-sm input-bordered flex-1"
              placeholder={t("显示名")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="block text-[12.5px]">
            <span className="opacity-60">{t("工作目录(一行一个,可多仓)")}</span>
            <textarea
              className="textarea textarea-bordered mt-1 w-full font-mono text-[12px] leading-relaxed"
              rows={3}
              value={dirsText}
              onChange={(e) => setDirsText(e.target.value)}
            />
          </label>
          <input
            className="input input-sm input-bordered w-full"
            placeholder={t("项目说明(可选,会注入新建 agent 的上下文)")}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />

          {members.length > 0 && (
            <div className="space-y-1 pt-1">
              <div className="text-[11px] font-medium uppercase tracking-wide opacity-40">{t("成员")}</div>
              {members.map((m) => (
                <div key={m.name} className="flex items-center gap-2 text-[12.5px]">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${m.status === "active" ? "bg-success" : "bg-base-content/25"}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {m.name.replace(/^agent-/, "")}
                    {m.purpose ? <span className="opacity-40"> · {m.purpose}</span> : null}
                  </span>
                  {others.length > 0 && (
                    <select
                      className="select select-bordered select-xs shrink-0"
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const to = e.target.value;
                        if (to) void run({ action: "assign", agent: m.name, id: to });
                      }}
                    >
                      <option value="">{t("转移到…")}</option>
                      {others.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.emoji || "📁"} {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              className="btn btn-primary btn-xs"
              disabled={busy || !dirty}
              onClick={() => {
                const dirs = dirsText.split("\n").map((s) => s.trim()).filter(Boolean);
                if (dirs.length === 0) {
                  setMsg(t("至少要一个工作目录"));
                  return;
                }
                void run({
                  action: "edit",
                  id: proj.id,
                  name: name.trim(),
                  emoji: emoji.trim(),
                  desc: desc.trim(),
                  dirs,
                }).then((ok) => ok && setExpand(false));
              }}
            >
              {t("保存")}
            </button>
            {members.length === 0 &&
              (confirmDel ? (
                <>
                  <button
                    className="btn btn-error btn-xs"
                    disabled={busy}
                    onClick={() => void run({ action: "remove", id: proj.id })}
                  >
                    {t("确认删除")}
                  </button>
                  <button className="btn btn-ghost btn-xs" onClick={() => setConfirmDel(false)}>
                    {t("取消")}
                  </button>
                </>
              ) : (
                <button className="btn btn-ghost btn-xs text-error/80" onClick={() => setConfirmDel(true)}>
                  {t("删除")}
                </button>
              ))}
            {members.length > 0 && (
              <span className="text-[11px] opacity-40">{t("有成员时不可删除(先转移)")}</span>
            )}
            {msg && <span className="text-[11px] text-error/80">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 新建 project 折叠表单。 */
function AddProjectForm({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [dirsText, setDirsText] = useState("");

  if (!open) {
    return (
      <button
        className="btn btn-ghost btn-sm w-full border border-dashed border-base-content/20"
        onClick={() => setOpen(true)}
      >
        ＋ {t("新建 project")}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl border border-base-content/10 bg-base-200/40 p-3">
      <div className="flex gap-2">
        <input
          className="input input-sm input-bordered w-14 text-center"
          placeholder="📁"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
        />
        <input
          className="input input-sm input-bordered w-32 font-mono"
          placeholder={t("id(小写)")}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <input
          className="input input-sm input-bordered flex-1"
          placeholder={t("显示名(可中文)")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <textarea
        className="textarea textarea-bordered w-full font-mono text-[12px]"
        rows={2}
        placeholder={t("工作目录,一行一个,如 ~/repos/qingniao/miniapp")}
        value={dirsText}
        onChange={(e) => setDirsText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <button
          className="btn btn-primary btn-xs"
          disabled={busy || !id.trim() || !dirsText.trim()}
          onClick={async () => {
            setBusy(true);
            setMsg("");
            const dirs = dirsText.split("\n").map((s) => s.trim()).filter(Boolean);
            const r = await projAction({
              action: "add",
              id: id.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(emoji.trim() ? { emoji: emoji.trim() } : {}),
              dirs,
            });
            setBusy(false);
            if (r.ok) {
              setOpen(false);
              setId("");
              setName("");
              setEmoji("");
              setDirsText("");
              onChanged();
            } else {
              setMsg(r.error || t("创建失败"));
            }
          }}
        >
          {t("创建")}
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => setOpen(false)}>
          {t("取消")}
        </button>
        {msg && <span className="text-[11px] text-error/80">{msg}</span>}
      </div>
    </div>
  );
}

export function ProjectsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const store = useChatStoreApi();
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/projects");
      const j = (await r.json()) as { ok?: boolean; error?: string; projects?: ProjectMeta[] };
      if (j.ok) setProjects(j.projects || []);
      else setErr(j.error || t("加载失败"));
    } catch {
      setErr(t("加载失败"));
    }
    setLoaded(true);
    // 侧栏分组跟着刷新(组头名/emoji/归属都可能变了)
    void store.loadProjects();
    void store.refreshAgents();
  }, [t, store]);

  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    void reload();
  }, [open, reload]);

  if (!open) return null;

  return createPortal(
    <div
      className="overlay-in fixed inset-0 z-[90] grid place-items-center bg-black/50 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="panel-pop flex max-h-[88dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("项目管理")}</span>
          <button className="btn btn-ghost btn-sm" aria-label={t("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-5 pb-5 pt-1">
          <p className="text-xs leading-relaxed text-base-content/50">
            {t("project = 一组工作目录 + 一组 agent。每个 agent 必属一个 project;新建 agent 不选时按目录自动归属。")}
          </p>
          {err && <div className="text-xs text-error/80">{err}</div>}
          {loaded && projects.length === 0 && !err && (
            <div className="py-4 text-center text-xs opacity-40">{t("还没有 project(新建 agent 会自动生成)")}</div>
          )}
          {projects.map((p) => (
            <ProjectRow key={p.id} proj={p} all={projects} onChanged={() => void reload()} />
          ))}
          <AddProjectForm onChanged={() => void reload()} />
        </div>
      </div>
    </div>,
    document.body
  );
}
