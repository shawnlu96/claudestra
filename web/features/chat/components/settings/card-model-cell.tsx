"use client";
import type { ClaudeModelOption } from "../../claude-models";
import type { EffectiveCell } from "./role-model-settings-api";
import { CARD_ROLE_LABELS, CARD_TIER_LABELS, useCardModelT } from "./card-model-i18n";
import type { Family } from "./card-model-draft";

export function CardModelCell({ tier, role, family, cell, value, models, efforts, disabled, onChange }: {
  tier: string; role: string; family: Family; cell: EffectiveCell; value: string; models: ClaudeModelOption[]; efforts: string[];
  disabled: boolean; onChange: (value: string) => void;
}) {
  const t = useCardModelT();
  const modelName = (v: string) => models.find((m) => m.value === v)?.label ?? v;
  const inherited = ["role-settings", "role-default"].includes(cell.source);
  const source = tier !== "undeclared" && inherited ? "跟随『未声明』那一格"
    : ["settings", "tier-settings"].includes(cell.source) ? "本页设置" : "产品默认";
  const options = family === "claude" ? models.map((m) => ({ value: m.value, label: m.label }))
    : efforts.filter((e) => e !== "ultra").map((e) => ({ value: e, label: e }));
  const known = options.some((o) => o.value === value) || ["default", "inherit", "down1", "global"].includes(value);
  const label = `${t(CARD_TIER_LABELS[tier])} ${t(CARD_ROLE_LABELS[role])} ${family === "claude" ? t("Claude 模型") : t("Codex 推理档")}`;
  return <div className="min-w-0 space-y-1" data-cell={`${tier}:${role}:${family}`}>
    <div className="break-words text-xs font-medium" data-effective>{cell.value === null ? t("跟随全局默认") : modelName(cell.value)}</div>
    <div className="break-words text-[10px] text-base-content/60" data-source>{t(source)}</div>
    {cell.note && <p className="break-words text-[10px] text-base-content/60">{t(cell.note)}</p>}
    <select className="select select-bordered select-xs w-full min-w-0 px-1 text-[10px]" value={value === "ultra" ? "" : value} aria-label={label}
      disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {tier !== "undeclared" && <><option value="default">{t("恢复产品默认")}</option><option value="inherit">{t("跟随")}</option></>}
      {family === "codex" && <option value="global">{t("跟随全局默认")}</option>}
      {family === "codex" && tier !== "undeclared" && <option value="down1">{t("降一档")}</option>}
      {!known && value !== "ultra" && <option value={value}>{modelName(value)}</option>}
      {value === "ultra" && <option value="" disabled hidden>{t("现存设置")}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
    <div className="break-words text-[9px] text-base-content/50">{family === "claude" ? t("Claude 推理档") : t("Codex 模型")} · {t("跟随全局默认")}</div>
    {(cell.value === "ultra" || value === "ultra") && <p className="break-words text-[10px] text-warning" role="note">{t("会自动派子 agent，卡片会话里不建议使用")}</p>}
  </div>;
}
