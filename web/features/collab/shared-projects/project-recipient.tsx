"use client";
import { useState } from "react";
import type { ProjectRecipient } from "@/lib/shared-projects-model";

/** N4 has no team directory. An existing person is explicitly identified, never inferred from a project member or transport peer. */
export function ProjectRecipientFields({ value, onChange }: {
  value: ProjectRecipient | null; onChange: (value: ProjectRecipient | null) => void;
}) {
  const [mode, setMode] = useState("existing");
  return <div className="space-y-2">
    <label className="block text-sm">邀请对象类型
      <select aria-label="邀请对象类型" className="select mt-1 w-full" value={mode} onChange={e => {
        setMode(e.target.value); onChange(null);
      }}>
        <option value="existing">已有中心成员（填写 personId）</option>
        <option value="new">新成员代号</option>
      </select>
    </label>
    {mode === "existing" ? <label className="block text-sm">已有中心成员 personId
      <input aria-label="邀请对象" className="input mt-1 w-full" value={value?.personId ?? ""} required maxLength={256}
        onChange={e => onChange(e.target.value.trim() ? { personId: e.target.value } : null)} />
    </label> : <label className="block text-sm">拟邀新成员代号
      <input aria-label="拟邀新成员代号" className="input mt-1 w-full" required maxLength={128} value={value?.code ?? ""}
        onChange={e => onChange(e.target.value.trim() ? { code: e.target.value } : null)} />
    </label>}
    <p className="text-xs opacity-60">中心暂未提供团队成员目录；请填写准确 personId。本人和已加入成员不能重复邀请。机器仅用于发送邀请。</p>
  </div>;
}
