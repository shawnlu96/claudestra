"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectFailure, projectErrorText, type ProjectMember, type ProjectSnapshot, type SharedProject, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { ActionStatus } from "./project-dialog";
import { useProjectAction } from "./use-projects";

export function ProjectMembers({ project, snapshot, port }: { project: SharedProject; snapshot: ProjectSnapshot; port: SharedProjectsPort }) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loadError, setLoadError] = useState("");
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const sequence = useRef(0);
  const { centerId, teamId, projectId } = project;
  const refresh = useCallback(async (signal: AbortSignal) => {
    const seq = ++sequence.current;
    try {
      const next = await port.members({ centerId, teamId, projectId }, signal);
      if (!signal.aborted && seq === sequence.current) { setMembers(next); setLoadError(""); }
    } catch (e) {
      if (!signal.aborted && seq === sequence.current) { setMembers([]); setLoadError(projectErrorText(e instanceof ProjectFailure ? e.status : 0)); }
    }
  }, [port, centerId, teamId, projectId]);
  useEffect(() => {
    const ctrl = new AbortController();
    void Promise.resolve().then(() => { if (!ctrl.signal.aborted) return refresh(ctrl.signal); });
    const timer = setInterval(() => void refresh(ctrl.signal), 15_000);
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [refresh]);
  const action = useProjectAction(refresh);
  const validPeers = peers.filter(id => snapshot.peers.some(p => p.id === id));
  return <section className="space-y-3 border-t border-base-300 pt-4">
    <h3 className="font-semibold">成员</h3>
    {loadError && <p role="alert" className="text-sm text-error">{loadError}</p>}
    <ul className="space-y-2">
      {members.map(m => <li key={m.personId} className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 break-words">{m.code} · {m.role === "owner" ? "项目 owner" : "成员"} · {memberStatus(m.status)}</span>
        {project.role === "owner" && m.status !== "removed" && <button type="button" className="btn btn-ghost btn-sm shrink-0"
          disabled={action.busy} onClick={() => setRemoving(m)} aria-label={`移出 ${m.code}`}>移出</button>}
      </li>)}
    </ul>
    {project.role === "owner" && <>
      {removing && <div role="alert" className="space-y-2 text-sm">
        <p>将 {removing.code} 移出项目 {project.name}？该成员将失去此项目的访问权限。</p>
        <div className="flex gap-2">
          <button type="button" className="btn btn-error btn-sm" disabled={action.busy} onClick={() => void action.run(async s => {
            await port.remove(project, removing.personId, s); if (!s.aborted) setRemoving(null);
          })}>确认移出</button>
          <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => setRemoving(null)}>取消</button>
        </div>
      </div>}
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (!validPeers.length) return; void action.run(async s => {
        await port.invite(project, { peers: validPeers, note: note.trim() }, s);
        if (!s.aborted) { setPeers([]); setNote(""); }
      }, "邀请已发送，等待对方确认加入。"); }}>
        <fieldset disabled={action.busy} className="space-y-2">
          <legend className="mb-2 font-medium">邀请 peer</legend>
          {!snapshot.peers.length && <p className="text-sm opacity-60">暂无已握手的 peer。</p>}
          {snapshot.peers.map(p => <label key={p.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="checkbox checkbox-sm" checked={peers.includes(p.id)} onChange={e => {
              setPeers(e.target.checked ? [...peers, p.id] : peers.filter(id => id !== p.id));
            }} />{p.name}
          </label>)}
          <label className="block text-sm">附言（可选）
            <input className="input mt-1 w-full" value={note} maxLength={500} onChange={e => setNote(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-sm" disabled={!validPeers.length}>邀请成员</button>
        </fieldset>
      </form>
    </>}
    <ActionStatus {...action} />
  </section>;
}

function memberStatus(status: ProjectMember["status"]) {
  return { active: "已加入", invited: "待加入", removed: "已移出" }[status];
}
