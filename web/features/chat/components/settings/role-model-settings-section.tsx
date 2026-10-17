"use client";
/**
 * 角色 × 家族的模型档位表（TIER1，设置「Claude」页里 Claude 全局默认下面的一节）：每个卡片角色一行，Claude 列选模型、Codex 列选推理档。
 * 每行自己的「保存」按钮，只带改了的格和读到的 rev；成功按回包刷新整表，失败把 bridge 原因显示在那一行、草稿保留；
 * 409（别处先改了）按回包里的现表刷新再提示，正在存的那一行草稿保留（rev 已换新，可直接再存）。403 / 404 整块不渲染；文件坏了 / 读不了有提示。
 * TIER3g：顶上选任务类型（或角色格），改的是那一层的格（PUT 带 tier）；每格下面是 bridge 算好的有效值与来源（effective），项目模式按 projects、
 * 模板可用按 templates 显示——不在前端猜默认值、继承或替用户降档。security 的选项限制只是提示，约束以服务端 400 为准。
 */
import { useEffect, useState } from "react";
import type { ClaudeModelOption } from "../../claude-models";
import { Section } from "./section";
import {
  baseRowOf, configErrorText, conflictView, effectiveOf, fetchRoleModels, patchOf, PROJECT_MODE_LABELS, putRoleModels, ROLE_LABELS, ROLE_LAYER,
  saveErrorText, SOURCE_LABELS, TIER_DEFAULT, useRoleModelT, type EffectiveCell, type RoleModelRow, type RoleModelView,
} from "./role-model-settings-api";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const SELECT = "select select-bordered select-sm w-full";
const LABEL = "label-text mb-1 text-xs text-base-content/60 sm:hidden";

function Effective({ cell, family }: { cell: EffectiveCell | undefined; family: "claude" | "codex" }) {
  const t = useRoleModelT();
  if (!cell) return null;
  return (
    <span className="mt-1 block break-words text-[11px] text-base-content/50" data-effective={family} data-value={cell.value ?? ""} data-source={cell.source}>
      {t("有效")}：<span className="font-medium text-base-content/80">{cell.value ?? t("照 Codex 配置")}</span> · {t(SOURCE_LABELS[cell.source] ?? cell.source)}
      {cell.note && <> · {cell.note}</>}
    </span>
  );
}

function RoleRow({ view, tier, role, models, onSaved }: {
  view: RoleModelView; tier: string; role: string; models: ClaudeModelOption[]; onSaved: (v: RoleModelView, note?: string) => void;
}) {
  const t = useRoleModelT();
  const row = baseRowOf(view, tier, role);
  const [draft, setDraft] = useState<RoleModelRow>(row);
  const [prev, setPrev] = useState<RoleModelRow>(row);
  if (prev.claude !== row.claude || prev.codex !== row.codex) {
    // 表刷新了（保存 / 409 现表）：没动过的格跟新值走，动过的格留草稿
    setPrev(row);
    setDraft({ role, claude: draft.claude === prev.claude ? row.claude : draft.claude, codex: draft.codex === prev.codex ? row.codex : draft.codex });
  }
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const patch = patchOf(view.rev, row, draft, tier);
  const isTier = tier !== ROLE_LAYER;
  const locked = tier === "security";
  const save = async () => {
    if (!patch) return;
    setSaving(true);
    setErr(null);
    try {
      const v = await putRoleModels(patch);
      setDraft(baseRowOf(v, tier, role));
      setPrev(baseRowOf(v, tier, role));
      onSaved(v);
    } catch (e) {
      const cur = conflictView(e);
      if (cur) onSaved(cur, `${t(ROLE_LABELS[role] ?? role)}：${t(errText(e))}`); // 草稿留着，按新 rev 再存
      else setErr(saveErrorText(e));
    } finally {
      setSaving(false);
    }
  };
  const special = isTier ? [{ value: TIER_DEFAULT, label: t("缺省（类型默认）") }, { value: "inherit", label: t("继承角色格") }] : [];
  const known = [...special, ...models];
  const claudeOpts = known.some((o) => o.value === draft.claude) ? known : [...special, { value: draft.claude, label: draft.claude }, ...models];
  const eff = effectiveOf(view, tier, role);
  return (
    <div className="grid grid-cols-2 items-start gap-x-3 gap-y-2 rounded-lg bg-base-100 p-3 sm:grid-cols-[11rem_1fr_1fr_auto] sm:py-2" data-role={role}>
      <div className="col-span-2 flex items-baseline gap-2 sm:col-span-1 sm:flex-col sm:gap-0 sm:self-center">
        <span className="text-sm font-medium">{t(ROLE_LABELS[role] ?? role)}</span>
        <span className="text-[11px] text-base-content/40">{role}</span>
      </div>
      <label className="form-control min-w-0">
        <span className={LABEL}>{t("Claude 模型")}</span>
        <select className={SELECT} aria-label={`${role} claude`} value={draft.claude} disabled={saving}
          onChange={(e) => setDraft({ ...draft, claude: e.target.value })}>
          {claudeOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Effective cell={eff?.claude} family="claude" />
      </label>
      <label className="form-control min-w-0">
        <span className={LABEL}>{t("Codex 推理档")}</span>
        <select className={SELECT} aria-label={`${role} codex`} value={draft.codex ?? ""} disabled={saving}
          onChange={(e) => setDraft({ ...draft, codex: e.target.value || null })}>
          {isTier && <option value={TIER_DEFAULT}>{t("缺省（类型默认）")}</option>}
          {isTier && <option value="inherit">{t("继承角色格")}</option>}
          {isTier && <option value="down1" disabled={locked}>{t("已知原档降一档")}</option>}
          <option value="" disabled={locked}>{t("照 Codex 配置")}</option>
          {view.codexEfforts.map((x) => <option key={x} value={x} disabled={locked}>{x}</option>)}
        </select>
        <Effective cell={eff?.codex} family="codex" />
      </label>
      <button type="button" className="btn btn-sm col-span-2 sm:col-span-1 sm:self-center" disabled={!patch || saving} onClick={() => void save()}>
        {saving && <span className="loading loading-spinner loading-xs" />}{t("保存")}
      </button>
      {err && <p className="col-span-2 break-words text-[11px] text-error sm:col-span-4" role="alert">{t("保存失败")}：{t(err)}</p>}
    </div>
  );
}

function TierPicker({ view, tier, setTier }: { view: RoleModelView; tier: string; setTier: (t: string) => void }) {
  const t = useRoleModelT();
  const projects = Object.entries(view.projects ?? {});
  return (
    <div className="space-y-2 rounded-lg bg-base-100 p-3">
      <label className="form-control min-w-0">
        <span className="label-text mb-1 text-xs text-base-content/60">{t("任务类型")}</span>
        <select className={SELECT} aria-label="task tier" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value={ROLE_LAYER}>{t("角色格（未声明类型）")}</option>
          {(view.taskTiers ?? []).map((x) => (
            <option key={x} value={x}>{x}{view.templates?.[x] === false ? `（${t("模板未注册")}）` : ""}</option>
          ))}
        </select>
      </label>
      {tier === "security" && <p className="break-words text-[11px] text-warning" data-testid="role-model-locked">🔒 {t("security 已锁定：Claude 必须是 Opus 档（继承时看角色格），Codex 只能沿用原档；不合规的保存由服务端拒绝")}</p>}
      {tier !== ROLE_LAYER && view.templates?.[tier] === false && (
        <p className="break-words text-[11px] text-warning" data-testid="role-model-no-template">{t("这个类型还没有注册流程模板：可以保存，但这类卡现在开不了")}</p>
      )}
      {view.projects && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]" data-testid="role-model-projects">
          <span className="text-base-content/60">{t("项目档位")}</span>
          {projects.length === 0 && <span className="text-base-content/40">{t("还没有项目")}</span>}
          {projects.map(([id, p]) => {
            const mode = p.diagnostic === undefined ? p.mode : undefined; // 有 diagnostic = 模式未知，不显示成关闭
            return (
              <span key={id} className="min-w-0 break-all" data-project={id} data-mode={mode ?? "unreadable"}>
                {id}：<span className={mode ? "font-medium" : "text-error"}>{mode ? t(PROJECT_MODE_LABELS[mode] ?? mode) : t("读不到")}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RoleModelSettingsSection({ modelOptions }: { modelOptions: ClaudeModelOption[] }) {
  const t = useRoleModelT();
  const [view, setView] = useState<RoleModelView | null | undefined>(undefined);
  const [tier, setTier] = useState<string>(ROLE_LAYER);
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
  const tiered = !!view?.taskTiers?.length;
  return (
    <Section title={t("角色模型档位")}
      desc={t("本机建卡时各角色用的模型 / 推理档。是否真正用于启动由恢复策略 roleModel 决定：缺省只观察（只在卡上记「本会用」，启动不变）。")}>
      <div className="space-y-2" data-testid="role-model-settings">
        {loadErr && <p className="break-words text-[11px] text-error" role="alert">{t("加载失败")}：{loadErr}</p>}
        {cfgErr && <p className="text-[11px] text-error" role="alert">{t(cfgErr)}</p>}
        {view && (
          <>
            {tiered && <TierPicker view={view} tier={tier} setTier={setTier} />}
            <div className="hidden grid-cols-[11rem_1fr_1fr_auto] gap-x-3 px-3 text-xs text-base-content/60 sm:grid">
              <span>{t("角色")}</span><span>{t("Claude 模型")}</span><span>{t("Codex 推理档")}</span><span className="w-12" />
            </div>
            {view.roles.map((r) => (
              // key 不带 rev / 值：409 刷新整表时正在存的那一行草稿留着；换类型才重建
              <RoleRow key={`${tier}:${r.role}`} view={view} tier={tier} role={r.role} models={modelOptions} onSaved={onSaved} />
            ))}
          </>
        )}
        {note && <p className={`break-words text-xs ${note.tone === "warn" ? "text-warning" : "text-base-content/60"}`} data-testid="role-model-note">{note.text}</p>}
      </div>
    </Section>
  );
}
