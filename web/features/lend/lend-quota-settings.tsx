"use client";
/**
 * 出借额度线设置（QLINE1，出借面板里的一块）：每个家族一行——本周已用条（带提醒线 / 停接线刻度）、状态、可接名额、两条线的输入；
 * 顶部是模式（执行 / 只观察 / 关闭）。数据与保存走 lend-quota-api（bridge GET / POST /lend/quota-lines），保存成功以回包为准刷新，
 * 失败把 bridge 原因显示在那一行、输入保留；403 / 404 整块不渲染。状态只看 bridge 判好的 state，不按百分比自己猜。
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchQuotaLines, postQuotaLines } from "./lend-quota-api";
import { useQuotaT } from "./lend-quota-i18n";
import {
  barWidth, configErrorText, draftOf, draftProblem, isDirty, lineBody, slotsText, stateBadge, usedText, warningText, type FamilyLine, type LineDraft, type LineMode, type QuotaLinesView,
} from "./lend-quota-model";
import css from "./lend-quota-settings.module.css";

const MODES: { mode: LineMode; label: string }[] = [{ mode: "on", label: "执行" }, { mode: "observe", label: "只观察" }, { mode: "off", label: "关闭" }];
const TONE = { success: "badge-success", warning: "badge-warning", error: "badge-error", muted: "badge-ghost" } as const;
const errText = (e: unknown): string => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const timeText = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** key 带两条线：服务端的线一变（保存成功 / 别处改了）就重挂，输入回到服务端值；没变时保留正在输入的草稿 */
function FamilyRow({ f, onSaved }: { f: FamilyLine; onSaved: (v: QuotaLinesView) => void }) {
  const t = useQuotaT();
  const [draft, setDraft] = useState<LineDraft>(() => draftOf(f));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = draftProblem(draft);
  const badge = stateBadge(f);
  const width = barWidth(f);
  const save = async () => {
    setSaving(true);
    setErr(null);
    try { onSaved(await postQuotaLines(lineBody(f.family, draft))); } catch (e) { setErr(errText(e)); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-1.5 rounded-lg bg-base-100 p-3" data-family={f.family}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{f.family}</span>
        <span className={`badge badge-sm ${TONE[badge.tone]}`} data-state={f.state}>{t(badge.text)}</span>
        <span className="ml-auto text-[11px] tabular-nums text-base-content/60">{t("可接")} {t(slotsText(f))}/{f.granted}</span>
      </div>
      <div className={css.bar} aria-label={`${t("本周已用")} ${usedText(f)}`}>
        {width !== null && <div className={`${css.fill} ${f.state === "stop" ? css.fillStop : f.state === "warn" ? css.fillWarn : ""}`} style={{ width: `${width}%` }} />}
        <span className={css.mark} style={{ left: `${f.warnPct}%` }} />
        <span className={`${css.mark} ${css.markStop}`} style={{ left: `${f.stopPct}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-base-content/60">
        <span>{t("本周已用")} <b className="tabular-nums">{t(usedText(f))}</b>{f.freshness === "last_known" && ` · ${t("上次读数")}`}</span>
        {f.resetAt !== null && <span className="tabular-nums">{t("重置")} {timeText(f.resetAt)}</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className={css.field}>
          <span>{t("提醒线")}</span>
          <input className="input input-sm input-bordered w-full" inputMode="numeric" value={draft.warn} aria-invalid={!!problem}
            onChange={(e) => setDraft({ ...draft, warn: e.target.value })} />
        </label>
        <label className={css.field}>
          <span>{t("停接线")}</span>
          <input className="input input-sm input-bordered w-full" inputMode="numeric" value={draft.stop} aria-invalid={!!problem}
            onChange={(e) => setDraft({ ...draft, stop: e.target.value })} />
        </label>
        <button type="button" className="btn btn-sm" disabled={!!problem || saving || !isDirty(f, draft)} onClick={() => void save()}>
          {saving && <span className="loading loading-spinner loading-xs" />}{t("保存")}
        </button>
      </div>
      {problem && isDirty(f, draft) && <p className="text-[11px] text-warning">{t(problem)}</p>}
      {err && <p className="break-words text-[11px] text-error" role="alert">{t("保存失败")}：{t(err)}</p>}
    </div>
  );
}

export function LendQuotaSettings() {
  const t = useQuotaT();
  const [view, setView] = useState<QuotaLinesView | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [modeErr, setModeErr] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const load = useCallback(async () => {
    try { setView(await fetchQuotaLines()); setLoadErr(null); } catch (e) { setLoadErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (view === null) return null;
  if (view === undefined) return loadErr ? <p className="text-[11px] text-error" role="alert">{t("额度线")} · {t("加载失败")}：{loadErr}</p> : null;
  const setMode = async (mode: LineMode) => {
    setModeBusy(true);
    setModeErr(null);
    try { setView(await postQuotaLines({ mode })); } catch (e) { setModeErr(errText(e)); } finally { setModeBusy(false); }
  };
  return (
    <div className="space-y-2" data-testid="lend-quota-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">{t("额度线")}</span>
        <div className="join">
          {MODES.map((m) => (
            <button key={m.mode} type="button" disabled={modeBusy} onClick={() => m.mode !== view.config.mode && void setMode(m.mode)}
              className={`btn join-item btn-xs ${view.config.mode === m.mode ? "btn-active" : ""}`} aria-pressed={view.config.mode === m.mode}>{t(m.label)}</button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-base-content/50">{t("本机该家族本周用量达到停接线后不再接新单，在跑的单不受影响")}</p>
      <p className="text-[11px] text-base-content/50">{t("达到提醒线后可接名额减半（至少留 1，原 0 仍 0）")}</p>
      {configErrorText(view.config) && <p className="text-[11px] text-error" role="alert">{t(configErrorText(view.config)!)}</p>}
      {warningText(view.warning) && <p className="break-words text-[11px] text-warning">{t(warningText(view.warning)!)}</p>}
      {modeErr && <p className="break-words text-[11px] text-error" role="alert">{t("保存失败")}：{t(modeErr)}</p>}
      {loadErr && <p className="break-words text-[11px] text-error">{t("加载失败")}：{loadErr}</p>}
      <div className="grid gap-2">{view.families.map((f) => <FamilyRow key={`${f.family}:${f.warnPct}:${f.stopPct}`} f={f} onSaved={setView} />)}</div>
    </div>
  );
}
