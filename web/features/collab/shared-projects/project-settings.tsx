"use client";
import { useState } from "react";
import { ProjectFailure, projectKey, type ProjectPatch, type SharedProject, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { ActionStatus } from "./project-dialog";
import { useProjectAction } from "./use-projects";

export function ProjectSettings({ project, port, refresh }: {
  project: SharedProject; port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [rev, setRev] = useState(project.rev);
  const [conflict, setConflict] = useState<{ current: SharedProject; patch: ProjectPatch } | null>(null);
  const action = useProjectAction(refresh);
  const update = async (patch: ProjectPatch, signal: AbortSignal) => {
    setConflict(null);
    try { await port.patch(project, patch, signal); if (!signal.aborted) setRev(patch.rev + 1); }
    catch (e) {
      if (!signal.aborted && e instanceof ProjectFailure && e.status === 409 && e.current && projectKey(e.current) === projectKey(project)) {
        setConflict({ current: e.current, patch });
      }
      throw e;
    }
  };
  return <section className="space-y-3">
    <p className="text-sm opacity-70">{project.status === "archived" ? "已归档" : "进行中"} · 版本 {project.rev}</p>
    {project.role === "owner" && <>
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); void action.run(s => update({ rev, name: name.trim() }, s)); }}>
        <label className="block text-sm">项目显示名
          <input className="input mt-1 w-full" value={name} required maxLength={64} onChange={e => { setName(e.target.value); setConflict(null); }} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm" disabled={action.busy || !name.trim()}>保存名称</button>
          <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void action.run(s => update({
            rev: project.rev, status: project.status === "active" ? "archived" : "active",
          }, s))}>{project.status === "active" ? "归档项目" : "恢复项目"}</button>
        </div>
      </form>
      {conflict && <div role="alert" className="rounded-lg border border-warning p-3 text-sm space-y-2">
        <p>当前名称：{conflict.current.name}</p>
        <p>当前状态：{conflict.current.status === "active" ? "进行中" : "已归档"} · 版本 {conflict.current.rev}</p>
        <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void action.run(s => update({
          ...conflict.patch, rev: conflict.current.rev,
        }, s))}>按当前版本重试</button>
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
  return <section className="space-y-3 border-t border-base-300 pt-4">
    <h3 className="font-semibold">本机对应关系</h3>
    <p className="break-words text-sm">团队项目 {project.name} ↔ {project.local ? `本机项目 ${project.local.name}（${project.local.id}）` : "本机尚未绑定"}</p>
    <p className="text-sm opacity-60">{project.availability === "ready" ? "项目已可用" : "中心项目已建，本机待完成"}</p>
    {project.local && <>
      <form className="space-y-2" onSubmit={e => {
        e.preventDefault(); void action.run(s => port.directories(project, dirs.split("\n").map(d => d.trim()).filter(Boolean), s));
      }}>
        <label className="block text-sm">本机目录（每行一个）
          <textarea className="textarea mt-1 w-full" rows={3} value={dirs} onChange={e => setDirs(e.target.value)} />
        </label>
        <p className="text-xs opacity-60">目录仅保存在这台机器；个人项目目录不能用于团队绑定。</p>
        <button className="btn btn-sm" disabled={action.busy}>设置目录</button>
      </form>
      {!leaveAvailable ? <p className="text-sm opacity-60">这台机器暂不支持退出团队项目。</p>
        : !leaving ? <button type="button" className="btn btn-sm btn-outline btn-error" onClick={() => setLeaving(true)}>退出团队项目</button>
        : <div className="space-y-2 text-sm">
          <p>确认退出 {project.name}？本机将不再显示此项目的团队 feature。</p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-error" disabled={action.busy} onClick={() => void action.run(s => port.leave(project, s))}>确认退出</button>
            <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => setLeaving(false)}>取消</button>
          </div>
        </div>}
    </>}
    <ActionStatus {...action} />
  </section>;
}
