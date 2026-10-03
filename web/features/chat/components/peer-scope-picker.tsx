"use client";
import { useId, useState } from "react";
import { useT } from "@/lib/i18n";
import { setAgentExternal } from "../agent-info";
import type { LocalAgent } from "./peers-shared";

type PickerProps = {
  localAgents: LocalAgent[];
  sel: string[];
  onChange: (v: string[]) => void;
  onOpened: () => void;
};

/** The three sharing entrances keep one gate UI. Search only controls rendering, never the selected scope. */
export function ScopePicker({ localAgents, sel, onChange, onOpened }: PickerProps) {
  const t = useT();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const star = sel.includes("*");
  const q = query.trim().toLowerCase();
  const visible = localAgents.filter(a => a.name.toLowerCase().includes(q));
  const toggle = (n: string) => onChange(sel.includes(n) ? sel.filter(x => x !== n) : [...sel, n]);
  const open = async (name: string) => {
    setBusy(true);
    setErr("");
    const r = await setAgentExternal(name, true);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setArming(null);
    if (!star && !sel.includes(name)) onChange([...sel, name]);
    onOpened();
  };
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor={searchId} className="sr-only">{t("搜索")} · {t("会话名")}</label>
        <input
          id={searchId} type="search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder={t("会话名")} autoComplete="off"
          className="input input-bordered input-sm min-w-0 flex-1 text-xs"
        />
        {query && <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={() => setQuery("")}>{t("清空")}</button>}
      </div>
      <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-2">
        <label className={`flex items-center gap-2 text-sm ${star ? "cursor-pointer" : "opacity-50"}`}>
          <input type="checkbox" className="checkbox checkbox-xs shrink-0" checked={star} disabled={!star} onChange={() => onChange([])} />
          <span>{t("全部普通 agent（*）")}</span>
          <span className="text-[10px] text-base-content/50">{t("暂不提供：请逐个选择已开闸的会话")}</span>
        </label>
        {visible.map(a => (
          <ScopeAgentRow key={a.name} agent={a} checked={star || sel.includes(a.name)} locked={!a.external && !sel.includes(a.name)}
            star={star} arming={arming === a.name} busy={busy} err={err} onToggle={() => toggle(a.name)}
            onArm={() => { setErr(""); setArming(arming === a.name ? null : a.name); }}
            onCancel={() => setArming(null)} onOpen={() => void open(a.name)} />
        ))}
        {visible.length === 0 && <div role="status" className="break-all py-2 text-xs text-base-content/50">
          {q ? <>{t("没有匹配「")}{query.trim()}{t("」的会话")}</> : t("暂无会话")}
        </div>}
      </div>
    </div>
  );
}

type RowProps = {
  agent: LocalAgent; checked: boolean; locked: boolean; star: boolean;
  arming: boolean; busy: boolean; err: string;
  onToggle(): void; onArm(): void; onCancel(): void; onOpen(): void;
};

function ScopeAgentRow({ agent: a, checked, locked, star, arming, busy, err, onToggle, onArm, onCancel, onOpen }: RowProps) {
  const t = useT();
  return (
    <div>
      <label className={`flex items-center gap-2 text-sm ${locked || star ? "" : "cursor-pointer"}`}>
        <input type="checkbox" className="checkbox checkbox-xs shrink-0" checked={checked} disabled={star || locked} onChange={onToggle} />
        <span className={`min-w-0 flex-1 break-all ${a.status === "active" ? "" : "opacity-50"}`}>{a.name}</span>
        {a.external ? <span className="badge badge-ghost badge-xs shrink-0">external</span> : (
          <button type="button" className="btn btn-ghost btn-xs h-5 min-h-0 shrink-0 gap-1 px-1.5 text-[10px] text-warning"
            title={t("开启 external 闸门")} onClick={onArm}>🔒 {t("未开闸")}</button>
        )}
      </label>
      {arming && !a.external && (
        <div className="my-1 ml-5 rounded-md bg-warning/10 p-2 text-[11px] leading-relaxed">
          <div>{t("开启后可共享给 peer；对方能看到该会话的全部上下文。关闭请到会话详情。")}</div>
          {err && <div className="mt-1 text-error">{err}</div>}
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" className="btn btn-warning btn-xs" disabled={busy} onClick={onOpen}>{busy ? "…" : t("开闸")}</button>
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={onCancel}>{t("取消")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
