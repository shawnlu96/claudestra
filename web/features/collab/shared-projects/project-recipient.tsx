"use client";
import { useState } from "react";
import type { ProjectRecipient, TeamDirectoryMember } from "@/lib/shared-projects-model";

/** An existing person comes from the center team directory when it is available, else an explicit personId; never from a peer. */
export function ProjectRecipientFields({ value, onChange, directory, excluded }: {
  value: ProjectRecipient | null; onChange: (value: ProjectRecipient | null) => void;
  directory?: TeamDirectoryMember[] | null; excluded?: readonly (string | undefined)[];
}) {
  const [mode, setMode] = useState("existing");
  // Only directory rows that can still be invited; option text is the code, a personId stays in the option value.
  const choices = directory?.filter(m => !excluded?.includes(m.personId));
  return <div className="space-y-2">
    <label className="block text-sm">邀请对象类型
      <select aria-label="邀请对象类型" className="select mt-1 w-full" value={mode} onChange={e => {
        setMode(e.target.value); onChange(null);
      }}>
        <option value="existing">{choices ? "从团队目录选择" : "已有中心成员（填写 personId）"}</option>
        <option value="new">新成员代号</option>
      </select>
    </label>
    {mode === "new" ? <label className="block text-sm">拟邀新成员代号
      <input aria-label="拟邀新成员代号" className="input mt-1 w-full" required maxLength={128} value={value?.code ?? ""}
        onChange={e => onChange(e.target.value.trim() ? { code: e.target.value } : null)} />
    </label> : choices ? <label className="block text-sm">从团队目录选择
      <select aria-label="从团队目录选择" className="select mt-1 w-full" required value={value?.personId ?? ""}
        onChange={e => onChange(e.target.value ? { personId: e.target.value } : null)}>
        <option value="">{choices.length ? "请选择团队成员" : "目录中暂无可邀请的成员"}</option>
        {choices.map(m => <option key={m.personId} value={m.personId}>{m.code}</option>)}
      </select>
    </label> : <label className="block text-sm">已有中心成员 personId
      <input aria-label="邀请对象" className="input mt-1 w-full" value={value?.personId ?? ""} required maxLength={256}
        onChange={e => onChange(e.target.value.trim() ? { personId: e.target.value } : null)} />
    </label>}
    <p className="text-xs opacity-60">{choices ? "不在团队目录里的人请用新成员代号。本人和已加入成员不能重复邀请。机器仅用于发送邀请。"
      : "中心暂未提供团队成员目录；请填写准确 personId。本人和已加入成员不能重复邀请。机器仅用于发送邀请。"}</p>
  </div>;
}
