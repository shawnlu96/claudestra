"use client";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api/client";
import type { ClaudeModelOption } from "../../claude-models";
import { Section } from "./section";
import { configErrorText, conflictView, fetchRoleModels, putRoleModels, type RoleModelView } from "./role-model-settings-api";
import { batchOf, cellKey, storedValue, type Draft, type Family } from "./card-model-draft";
import { cardModelError, CARD_ROLE_LABELS, CARD_TIER_LABELS, useCardModelT } from "./card-model-i18n";
import { CardModelCell } from "./card-model-cell";

function Switches({ view }: { view: RoleModelView }) {
  const t = useCardModelT();
  const state = (mode: string) => t(mode === "on" ? "生效" : mode === "observe" ? "只记录，不改启动参数" : "不生效");
  return <div className="flex flex-wrap gap-2 text-xs" data-testid="card-model-switches">
    <span className="self-center text-base-content/60">{t("开关对应项目")} · {view.switches.project}</span>
    <span className="rounded-lg bg-base-100 px-3 py-2">{t("任务类型")} · {state(view.switches.taskTierModels.mode)}</span>
    <span className="rounded-lg bg-base-100 px-3 py-2">{t("角色格")} · {state(view.switches.roleModel.mode)}</span>
  </div>;
}

function ModelTable({ view, tiers, models, draft, saving, change }: {
  view: RoleModelView; tiers: string[]; models: ClaudeModelOption[]; draft: Draft; saving: boolean;
  change: (key: string, value: string) => void;
}) {
  const t = useCardModelT();
  const off = (tier: string) => (tier === "undeclared" ? view.switches.roleModel : view.switches.taskTierModels).mode === "off";
  const renderCell = (tier: string, role: string, family: Family) => {
    const key = cellKey(tier, role, family);
    const cell = view.effective[tier].find((row) => row.role === role)![family];
    return <td key={key} className={`min-w-0 border-t border-base-300 p-1.5 align-top ${off(tier) ? "bg-base-300/40 opacity-50" : ""}`}>
      <CardModelCell tier={tier} role={role} family={family} cell={cell} value={draft[key] ?? storedValue(view, tier, role, family)}
        models={models} efforts={view.codexEfforts} disabled={saving || off(tier)} onChange={(value) => change(key, value)} />
    </td>;
  };
  return <table className="w-full table-fixed border-collapse text-left" data-testid="card-model-table">
    <thead><tr><th rowSpan={2} className="w-16 p-1.5 text-[11px]">{t("职责")}</th>
      {tiers.map((tier) => <th key={tier} colSpan={2} className="p-1.5 text-center text-xs">{t(CARD_TIER_LABELS[tier])}</th>)}
    </tr><tr>{tiers.flatMap((tier) => ["Claude", "Codex"].map((family) =>
      <th key={`${tier}:${family}`} className="p-1.5 text-[10px] text-base-content/60">{family}</th>))}</tr></thead>
    <tbody>{view.roles.map(({ role }) => <tr key={role}>
      <th className="break-words border-t border-base-300 p-1.5 text-[11px] font-medium">{t(CARD_ROLE_LABELS[role])}</th>
      {tiers.flatMap((tier) => (["claude", "codex"] as const).map((family) => renderCell(tier, role, family)))}
    </tr>)}</tbody>
  </table>;
}

export function CardModelSettingsSection({ modelOptions }: { modelOptions: ClaudeModelOption[] }) {
  const t = useCardModelT();
  const [view, setView] = useState<RoleModelView | null>();
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchRoleModels().then((v) => { if (live) setView(v); }, () => { if (live) setError("加载失败"); });
    return () => { live = false; };
  }, []);
  if (view === null) return null;
  const batch = view ? batchOf(view, draft) : null;
  const save = async () => {
    if (!batch?.changes.length) return;
    setSaving(true); setError(null); setNote(null);
    try {
      const next = await putRoleModels(batch);
      setView(next); setDraft({});
      setNote(next.warning ? "原档位表文件损坏，已另存备份后按这次保存的内容重写" : "已保存");
    } catch (e) {
      const current = conflictView(e);
      if (current) { setView(current); setDraft({}); setNote("别处先改了，已刷新，请重新检查"); }
      else setError(e instanceof ApiError ? String(e.body.reason ?? e.message) : "保存失败");
    } finally { setSaving(false); }
  };
  const tiers = view ? [...view.taskTiers, "undeclared"] : [];
  const props = view ? { view, models: modelOptions, draft, saving, change: (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value })) } : null;
  const cfg = view && configErrorText(view.config);
  return <Section title={t("卡片模型")} desc={t("每格显示服务端解析值；观察或关闭时不会用于启动。")}
    aside={<button className="btn btn-sm btn-primary" disabled={saving || !batch?.changes.length} onClick={() => void save()}>
      {saving && <span className="loading loading-spinner loading-xs" />}{t("保存")}</button>}>
    <div className="space-y-3" data-testid="card-model-settings" aria-busy={saving}>
      {!view && !error && <p className="text-xs">{t("加载中")}</p>}
      {error && <p className="break-words text-xs text-error" role="alert">{cardModelError(error, t)}</p>}
      {cfg && <p className="text-xs text-warning" role="alert">{t(cfg)}</p>}
      {view && props && <>
        <Switches view={view} />
        <p className="text-[11px] text-base-content/60">{t("安全下限：Claude 至少 Opus；Codex 只能跟随原档。")}</p>
        <div className="hidden overflow-x-auto xl:block"><div className="min-w-[1000px]"><ModelTable {...props} tiers={tiers} /></div></div>
        <div className="space-y-4 xl:hidden">{tiers.map((tier) => <div key={tier} className="rounded-lg bg-base-100 p-2">
          <ModelTable {...props} tiers={[tier]} />
        </div>)}</div>
      </>}
      {note && <p className="text-xs text-base-content/70" role="status" data-testid="card-model-note">{t(note)}</p>}
    </div>
  </Section>;
}
