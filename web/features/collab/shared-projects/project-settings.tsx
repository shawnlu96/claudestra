"use client";
import { useState } from "react";
import { ProjectFailure, projectKey, type ProjectPatch, type SharedProject, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { sharedProjectsTr } from "@/lib/i18n-dict-shared-projects";
import { useLang } from "@/lib/i18n";
import { ActionStatus } from "./project-dialog";
import { useProjectAction } from "./use-projects";

export function ProjectSettings({ project, port, refresh }: {
  project: SharedProject; port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const [editor, setEditor] = useState<{ source: SharedProject; draft: string; baseRev: number; baseName: string; dirty: boolean;
    conflict: { current: SharedProject; patch: ProjectPatch } | null }>({ source: project, draft: project.name,
    baseRev: project.rev, baseName: project.name, dirty: false, conflict: null });
  // A dirty draft retains its original CAS authority until an explicit retry; refresh only exposes newer competing values.
  if (editor.source !== project) setEditor(previous => {
    const conflict = previous.conflict && project.rev > previous.conflict.current.rev
      ? { ...previous.conflict, current: project } : previous.conflict;
    return { ...previous, source: project,
      ...(!previous.dirty ? { draft: project.name, baseRev: project.rev, baseName: project.name } : {}),
      conflict: conflict ?? (previous.dirty && project.rev > previous.baseRev && project.name !== previous.baseName
        ? { current: project, patch: { rev: previous.baseRev, name: previous.draft.trim() } } : null),
    };
  });
  const { draft, baseRev, conflict } = editor;
  const action = useProjectAction(refresh);
  const tr = sharedProjectsTr(useLang());
  const update = async (patch: ProjectPatch, signal: AbortSignal) => {
    setEditor(previous => ({ ...previous, conflict: null }));
    try {
      await port.patch(project, patch, signal);
      if (!signal.aborted) setEditor(previous => patch.name !== undefined && previous.draft.trim() === patch.name
        ? { ...previous, baseRev: patch.rev + 1, baseName: patch.name, dirty: false } : previous);
    }
    catch (e) {
      if (!signal.aborted && e instanceof ProjectFailure && e.status === 409 && e.current && projectKey(e.current) === projectKey(project)) {
        const current = e.current;
        setEditor(previous => ({ ...previous, conflict: { current, patch } }));
      }
      throw e;
    }
  };
  return <section className="space-y-3">
    <p className="text-sm opacity-70">{tr(project.status === "archived" ? "已归档" : "进行中")} · {tr("版本 {rev}", { rev: project.rev })}</p>
    {project.role === "owner" && <>
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); void action.run(s => update({ rev: baseRev, name: draft.trim() }, s)); }}>
        <label className="block text-sm">{tr("项目显示名")}
          <input className="input mt-1 w-full" value={draft} required maxLength={64} onChange={e => {
            const value = e.target.value; setEditor(previous => ({ ...previous, draft: value, dirty: true, conflict: null }));
          }} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" disabled={action.busy || !draft.trim()}>{tr("保存名称")}</button>
          <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void action.run(s => update({
            rev: baseRev, status: project.status === "active" ? "archived" : "active",
          }, s))}>{tr(project.status === "active" ? "归档项目" : "恢复项目")}</button>
        </div>
      </form>
      {conflict && <div role="alert" className="rounded-lg border border-warning p-3 text-sm space-y-2">
        <p>{tr("当前名称：{name}", { name: conflict.current.name })}</p>
        <p>{tr("当前状态：{status} · 版本 {rev}", { status: tr(conflict.current.status === "active" ? "进行中" : "已归档"), rev: conflict.current.rev })}</p>
        <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => {
          setEditor(previous => ({ ...previous, baseRev: conflict.current.rev, baseName: conflict.current.name }));
          void action.run(s => update({ ...conflict.patch, rev: conflict.current.rev }, s));
        }}>{tr("按当前版本重试")}</button>
      </div>}
    </>}
    <ActionStatus {...action} />
  </section>;
}

export function LocalProjectSettings({ project, port, refresh, leaveAvailable = true }: {
  project: SharedProject; port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void>; leaveAvailable?: boolean;
}) {
  const [dirs, setDirs] = useState(project.local?.dirs.join("\n") ?? "");
  const [leaving, setLeaving] = useState(false);
  const action = useProjectAction(refresh);
  const tr = sharedProjectsTr(useLang());
  return <section className="space-y-3 border-t border-base-300 pt-4">
    <h3 className="font-semibold">{tr("本机对应关系")}</h3>
    <p className="break-words text-sm">{tr("团队项目 {name}", { name: project.name })} ↔ {project.local
      ? tr("本机项目 {name}（{id}）", { name: project.local.name, id: project.local.id }) : tr("本机尚未绑定")}</p>
    <p className="text-sm opacity-60">{tr(project.availability === "ready" ? "项目已可用" : "中心项目已建，本机待完成")}</p>
    {project.local && <>
      <form className="space-y-2" onSubmit={e => {
        e.preventDefault(); void action.run(s => port.directories(project, dirs.split("\n").map(d => d.trim()).filter(Boolean), s));
      }}>
        <label className="block text-sm">{tr("本机目录（每行一个）")}
          <textarea className="textarea mt-1 w-full" rows={3} value={dirs} onChange={e => setDirs(e.target.value)} />
        </label>
        <p className="text-xs opacity-60">{tr("目录仅保存在这台机器；个人项目目录不能用于团队绑定。")}</p>
        <button className="btn btn-sm" disabled={action.busy}>{tr("设置目录")}</button>
      </form>
      {!leaveAvailable ? <p className="text-sm opacity-60">{tr("这台机器暂不支持退出团队项目。")}</p>
        : !leaving ? <button type="button" className="btn btn-sm btn-outline btn-error" onClick={() => setLeaving(true)}>{tr("退出团队项目")}</button>
        : <div className="space-y-2 text-sm">
          <p>{tr("确认退出 {name}？本机将不再显示此项目的团队 feature。", { name: project.name })}</p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-error" disabled={action.busy} onClick={() => void action.run(s => port.leave(project, s))}>{tr("确认退出")}</button>
            <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => setLeaving(false)}>{tr("取消")}</button>
          </div>
        </div>}
    </>}
    <ActionStatus {...action} />
  </section>;
}
