"use client";
import { useState } from "react";
import { projectChoiceWire, type SharedProjectChoice } from "@/lib/shared-projects-choice";

export function ProjectChoice({ choice, busy, accept, decline, onAnswer }: {
  choice: SharedProjectChoice; busy: boolean;
  accept: { id: string; label: string }; decline: { id: string; label: string };
  onAnswer: (choices: string[]) => void;
}) {
  const [selected, setSelected] = useState(choice.recommended);
  const wire = projectChoiceWire(choice, selected);
  return <div className="space-y-3">
    <label className="block text-sm">加入后对应的本机项目
      <select className="select mt-1 w-full" disabled={busy} value={wire ? selected : ""} onChange={e => setSelected(e.target.value)}>
        <option value="">请选择本机项目</option>
        {choice.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
    {choice.options.find(o => o.value === selected)?.description && <p className="text-sm opacity-60">
      {choice.options.find(o => o.value === selected)?.description}
    </p>}
    <p className="text-xs opacity-60">{choice.recommended ? "推荐选项已选中；" : "请选择本机项目；"}只有点击确认才会加入。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !wire}
        onClick={() => wire && onAnswer([`[button:${accept.id}]`, wire])}>{accept.label}</button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAnswer([`[button:${decline.id}]`])}>{decline.label}</button>
    </div>
  </div>;
}
