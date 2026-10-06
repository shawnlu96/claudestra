"use client";
import { useState } from "react";
import type { ProjectMember, ProjectRecipient } from "@/lib/shared-projects-model";

/** Candidates come from the members port; choosing a transport peer never chooses a person. */
export function ProjectRecipientFields({ members, value, onChange }: {
  members: ProjectMember[]; value: ProjectRecipient | null; onChange: (value: ProjectRecipient | null) => void;
}) {
  const [mode, setMode] = useState("existing");
  const selected = value?.personId && members.some(m => m.personId === value.personId) ? value.personId : "";
  return <div className="space-y-2">
    <label className="block text-sm">邀请对象类型
      <select aria-label="邀请对象类型" className="select mt-1 w-full" value={mode} onChange={e => {
        setMode(e.target.value); onChange(null);
      }}>
        <option value="existing">已有中心成员</option>
        <option value="new">新成员代号</option>
      </select>
    </label>
    {mode === "existing" ? <label className="block text-sm">邀请对象
      <select aria-label="邀请对象" className="select mt-1 w-full" value={selected} required onChange={e => {
        const member = members.find(m => m.personId === e.target.value);
        onChange(member ? { personId: member.personId } : null);
      }}>
        <option value="">请选择中心成员</option>
        {members.map(m => <option key={m.personId} value={m.personId}>{m.code}</option>)}
      </select>
    </label> : <label className="block text-sm">拟邀新成员代号
      <input aria-label="拟邀新成员代号" className="input mt-1 w-full" required maxLength={128} value={value?.code ?? ""}
        onChange={e => onChange(e.target.value.trim() ? { code: e.target.value } : null)} />
    </label>}
    <p className="text-xs opacity-60">请明确选择邀请对象；下面选择的机器仅用于发送邀请。</p>
  </div>;
}
