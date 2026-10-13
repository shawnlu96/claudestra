"use client";
/**
 * 角色 × 家族的模型档位表（TIER1，设置「Claude」页里 Claude 全局默认下面的一节）：每个卡片角色一行，Claude 列选模型、Codex 列选推理档。
 * 每行自己的「保存」按钮，只带改了的格和读到的 rev；成功按回包刷新整表，失败把 bridge 原因显示在那一行、草稿保留；
 * 409（别处先改了）按回包里的现表刷新再提示。403 / 404 整块不渲染；文件坏了 / 读不了有提示。不在前端猜默认值或替用户降档。
 */
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api/client";
import type { ClaudeModelOption } from "../../claude-models";
import { Section } from "./section";
import {
  configErrorText, conflictView, fetchRoleModels, patchOf, putRoleModels, ROLE_LABELS, useRoleModelT, type RoleModelRow, type RoleModelView,
} from "./role-model-settings-api";

const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const SELECT = "select select-bordered select-sm w-full";
const LABEL = "label-text mb-1 text-xs text-base-content/60 sm:hidden";

function RoleRow({ row, rev, models, efforts, onSaved }: {
  row: RoleModelRow; rev: number; models: ClaudeModelOption[]; efforts: string[]; onSaved: (v: RoleModelView, note?: string) => void;
}) {
  const t = useRoleModelT();
  const [draft, setDraft] = useState<RoleModelRow>(row);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const patch = patchOf(rev, row, draft);
  const save = async () => {
    if (!patch) return;
    setSaving(true);
    setErr(null);
    try {
      onSaved(await putRoleModels(patch));
    } catch (e) {
      const cur = conflictView(e);
      if (cur) onSaved(cur, `${t(ROLE_LABELS[row.role] ?? row.role)}：${t(errText(e))}`);
      else setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };
  const claudeOpts = models.some((o) => o.value === draft.claude) ? models : [{ value: draft.claude, label: draft.claude }, ...models];
  return (
    <div className="grid grid-cols-2 items-end gap-x-3 gap-y-2 rounded-lg bg-base-100 p-3 sm:grid-cols-[11rem_1fr_1fr_auto] sm:py-2" data-role={row.role}>
      <div className="col-span-2 flex items-baseline gap-2 sm:col-span-1 sm:flex-col sm:gap-0 sm:self-center">
        <span className="text-sm font-medium">{t(ROLE_LABELS[row.role] ?? row.role)}</span>
        <span className="text-[11px] text-base-content/40">{row.role}</span>
      </div>
      <label className="form-control min-w-0">
        <span className={LABEL}>{t("Claude 模型")}</span>
        <select className={SELECT} aria-label={`${row.role} claude`} value={draft.claude} disabled={saving}
          onChange={(e) => setDraft({ ...draft, claude: e.target.value })}>
          {claudeOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label className="form-control min-w-0">
        <span className={LABEL}>{t("Codex 推理档")}</span>
        <select className={SELECT} aria-label={`${row.role} codex`} value={draft.codex ?? ""} disabled={saving}
          onChange={(e) => setDraft({ ...draft, codex: e.target.value || null })}>
          <option value="">{t("照 Codex 配置")}</option>
          {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      <button type="button" className="btn btn-sm col-span-2 sm:col-span-1" disabled={!patch || saving} onClick={() => void save()}>
        {saving && <span className="loading loading-spinner loading-xs" />}{t("保存")}
      </button>
      {err && <p className="col-span-2 break-words text-[11px] text-error sm:col-span-4" role="alert">{t("保存失败")}：{t(err)}</p>}
    </div>
  );
}

export function RoleModelSettingsSection({ modelOptions }: { modelOptions: ClaudeModelOption[] }) {
  const t = useRoleModelT();
  const [view, setView] = useState<RoleModelView | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  useEffect(() => {
    let live = true; // 卸载后迟到的回包不落 state
    fetchRoleModels().then((v) => { if (live) setView(v); }, (e) => { if (live) setLoadErr(errText(e)); });
    return () => { live = false; };
  }, []);
  if (view === null) return null;
  const onSaved = (v: RoleModelView, warn?: string) => {
    setView(v);
    setNote(warn ? { text: warn, tone: "warn" } : { text: v.warning === "replaced_invalid" ? t("原档位表文件损坏，已另存备份后按这次保存的内容重写") : t("已保存"), tone: "ok" });
  };
  const cfgErr = view ? configErrorText(view.config) : null;
  return (
    <Section title={t("角色模型档位")}
      desc={t("本机建卡时各角色用的模型 / 推理档。是否真正用于启动由恢复策略 roleModel 决定：缺省只观察（只在卡上记「本会用」，启动不变）。")}>
      <div className="space-y-2" data-testid="role-model-settings">
        {loadErr && <p className="break-words text-[11px] text-error" role="alert">{t("加载失败")}：{loadErr}</p>}
        {cfgErr && <p className="text-[11px] text-error" role="alert">{t(cfgErr)}</p>}
        {view && (
          <>
            <div className="hidden grid-cols-[11rem_1fr_1fr_auto] gap-x-3 px-3 text-xs text-base-content/60 sm:grid">
              <span>{t("角色")}</span><span>{t("Claude 模型")}</span><span>{t("Codex 推理档")}</span><span className="w-12" />
            </div>
            {view.roles.map((r) => (
              <RoleRow key={`${r.role}:${view.rev}:${r.claude}:${r.codex ?? ""}`} row={r} rev={view.rev} models={modelOptions} efforts={view.codexEfforts} onSaved={onSaved} />
            ))}
          </>
        )}
        {note && <p className={`break-words text-xs ${note.tone === "warn" ? "text-warning" : "text-base-content/60"}`} data-testid="role-model-note">{note.text}</p>}
      </div>
    </Section>
  );
}
