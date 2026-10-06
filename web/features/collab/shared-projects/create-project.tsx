"use client";
import { useState, type Dispatch, type SetStateAction } from "react";
import { eligibleLocals, teamKey, type CreateProject, type ProjectSnapshot, type SharedProjectsPort } from "@/lib/shared-projects-model";
import { ActionStatus } from "./project-dialog";
import { useProjectAction } from "./use-projects";

export function CreateProjectForm({ snapshot, port, refresh, pending, setPending }: {
  snapshot: ProjectSnapshot; port: SharedProjectsPort; refresh: (signal: AbortSignal) => Promise<void>;
  pending: CreateProject | null; setPending: Dispatch<SetStateAction<CreateProject | null>>;
}) {
  const teams = snapshot.teams.filter(t => t.teamRole === "owner");
  const [team, setTeam] = useState(teams[0] ? teamKey(teams[0]) : "");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [local, setLocal] = useState("");
  const action = useProjectAction(refresh);
  const selected = teams.find(t => teamKey(t) === team);
  const locals = eligibleLocals(snapshot);
  const validLocal = !local || locals.some(p => p.id === local);
  const canCreate = !!selected && validLocal && !!name.trim() && !action.busy && !pending;
  if (!teams.length) return <p className="text-sm opacity-60">{snapshot.teams.some(t => t.teamRole === null)
    ? "中心暂未提供团队权限，创建项目暂不可用。" : "仅团队 owner 可以新建团队项目。"}</p>;
  const submit = () => {
    if (!selected || !canCreate) return;
    const input: CreateProject = { centerId: selected.centerId, teamId: selected.teamId, name: name.trim(),
      ...(id.trim() ? { id: id.trim() } : {}), ...(local ? { localProjectId: local } : {}), operationId: crypto.randomUUID() };
    setPending(input);
    void action.run(async signal => {
      await port.create(input, signal);
      if (!signal.aborted) { setPending(null); setName(""); setId(""); setLocal(""); }
    }, "创建已处理，请查看本机可用状态。");
  };
  return <section className="space-y-3">
    <h3 className="font-semibold">新建团队项目</h3>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); submit(); }}>
      <fieldset disabled={action.busy || !!pending} className="space-y-3">
        <label className="block text-sm">团队
          <select className="select mt-1 w-full" value={selected ? team : ""} onChange={e => setTeam(e.target.value)} required>
            <option value="">请选择团队</option>
            {teams.map(t => <option key={teamKey(t)} value={teamKey(t)}>{t.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">显示名
          <input className="input mt-1 w-full" required maxLength={64} value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="block text-sm">项目 ID（可选，创建后不可改）
          <input className="input mt-1 w-full" maxLength={32} pattern="[a-z0-9][a-z0-9_-]{0,31}" value={id} onChange={e => setId(e.target.value)} />
        </label>
        <label className="block text-sm">本机对应项目
          <select className="select mt-1 w-full" value={validLocal ? local : "unavailable"} onChange={e => setLocal(e.target.value)}>
            {!validLocal && <option value="unavailable" disabled>原本机项目已不可绑定，请重新选择</option>}
            <option value="">新建本机项目（稍后设置目录）</option>
            {locals.map(p => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" disabled={!canCreate}>创建项目</button>
      </fieldset>
    </form>
    {pending && <div className="space-y-2 text-sm">
      <p>创建结果待确认。继续将查询同一次创建操作，不会重复创建。</p>
      <button type="button" className="btn btn-sm" disabled={action.busy || !teams.some(t => teamKey(t) === teamKey(pending))}
        onClick={() => void action.run(async signal => {
          await port.complete(pending, signal);
          if (!signal.aborted) { setPending(null); setName(""); setId(""); setLocal(""); }
      }, "恢复已处理，请查看本机可用状态。")}>继续完成项目</button>
    </div>}
    <ActionStatus {...action} />
  </section>;
}
