"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { ApiError } from "@/lib/api/client";
import { useChatStoreApi } from "../chat-store";
import { fetchAgentSkills, markSkillsPending, setAgentSkill, useSkillsPending } from "../agent-skills-api";
import { displaySkillName, OUTSIDE_LABEL, SKILL_STATES, sortRows, STATE_HINT, STATE_LABEL, type AgentSkillRow, type AgentSkillView, type SkillState } from "../agent-skills-logic";
import { SCOPE_LABEL } from "../skills-library-logic";

/**
 * 按会话启停技能（台账 i03 第一期）：会话详情弹窗里一栏，技能库页里给大总管一份。
 * 默认一个开关（开 / 关），「显示全部档位」后每行是四档分段控件。改完只提示「重启后生效」+ 重启按钮，不自动重启
 * （CC 运行中不重读 --settings，src/lib/agent-settings.ts 顶部的实测）。没有 manage 权限（403）整栏不显示。
 */
export function AgentSkillsSection({ name, master = false }: { name: string; master?: boolean }) {
  const t = useT();
  const [view, setView] = useState<AgentSkillView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState("");
  // 按技能记忙：连点两个开关时，先回来的那个不能把另一个的忙状态清掉
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [full, setFull] = useState(false);
  const [q, setQ] = useState("");
  const seq = useRef(0);
  // 每次改完都重拉；只认最新一次的结果，后到的旧响应不许盖掉新状态
  const load = () => {
    const my = ++seq.current;
    return fetchAgentSkills(name)
      .then((r) => my === seq.current && setView(r.view))
      .catch((e: Error) => my === seq.current && (e instanceof ApiError && e.status === 403 ? setHidden(true) : setErr(e.message)));
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 name 重拉
  }, [name]);
  const change = async (skill: string, state: SkillState) => {
    setBusy((b) => new Set(b).add(skill));
    setErr("");
    try {
      const r = await setAgentSkill(name, skill, state);
      if (!r.ok) throw new Error(r.error ?? "failed");
      markSkillsPending(name, true);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(skill);
        return n;
      });
    }
  };
  if (hidden) return null;
  const rows = view ? sortRows(view.rows, q) : [];
  const off = view?.rows.filter((r) => r.state !== "on").length ?? 0;
  const fourStates = view?.runtime === "claude-code";
  return (
    <div className="mt-3 rounded-xl border border-base-300 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{t("这个会话的技能")}</div>
          <div className="mt-0.5 text-[12px] text-base-content/55">
            {view ? t("{n} 个，{m} 个调过档位", { n: view.rows.length, m: off }) : t("只影响这个会话，改完重启后生效。")}
          </div>
        </div>
        {view?.supported && fourStates && (
          <button className="btn btn-ghost btn-xs shrink-0 font-normal" onClick={() => setFull((v) => !v)}>
            {full ? t("只显示开关") : t("显示全部档位")}
          </button>
        )}
      </div>
      {fourStates && (
        <div className="mt-1 text-[11.5px] text-base-content/50">{t("这里只管这个会话自己的开关。全局或项目设置里的技能开关这里改不了，只在对应技能旁标出。")}</div>
      )}
      {master && <div className="mt-2 text-[12px] text-warning">{t("大总管的技能被关可能影响它的日常流程，比如 save-compact。")}</div>}
      <PendingBar name={name} master={master} />
      {err && <div className="mt-2 text-[12px] text-error">{err}</div>}
      {!view && !err && <span className="loading loading-spinner loading-xs mt-2" />}
      {view && !view.supported && (
        <div className="mt-2 text-[12px] text-base-content/60">
          {view.reason === "codex" ? t("Codex 暂不支持按会话启停技能（它的技能目录是全局的）。") : t("这个 Pi 会话是「继承全局」档：全部技能都启用。切到最小集（minimal）才能逐个管。")}
        </div>
      )}
      {view && view.rows.length > 8 && (
        <input className="input input-bordered input-xs mt-2 w-full" value={q} placeholder={t("搜索技能")} onChange={(e) => setQ(e.target.value)} />
      )}
      {view && view.rows.length > 0 && (
        <ul className="mt-2 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0">
          {rows.map((r) => (
            <SkillToggleRow key={r.name} r={r} full={full && fourStates} readOnly={!view.supported || !!r.lockedBy} busy={busy.has(r.name)} onChange={(s) => void change(r.name, s)} />
          ))}
        </ul>
      )}
      {view && view.supported && view.rows.length === 0 && <p className="mt-2 text-[12px] text-base-content/50">{t("没有可管的技能")}</p>}
    </div>
  );
}

function PendingBar({ name, master }: { name: string; master: boolean }) {
  const t = useT();
  const store = useChatStoreApi();
  const pending = useSkillsPending(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!pending) return null;
  const restart = async () => {
    setBusy(true);
    setErr("");
    const r = await store.restartAgent(name);
    setBusy(false);
    if (r.ok) markSkillsPending(name, false);
    else setErr(r.error ?? "failed");
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-info/10 px-2.5 py-1.5 text-[12px]">
      <span className="min-w-0 flex-1">{master ? t("重启大总管后生效（设置 · 会话与自动化里的「重启全部会话」会连大总管一起重启）。") : t("改动重启后生效。")}</span>
      {!master && (
        <button className="btn btn-primary btn-xs" disabled={busy} onClick={() => void restart()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : t("重启")}
        </button>
      )}
      {err && <span className="w-full text-error">{err}</span>}
    </div>
  );
}

function SkillToggleRow({ r, full, readOnly, busy, onChange }: { r: AgentSkillRow; full: boolean; readOnly: boolean; busy: boolean; onChange: (s: SkillState) => void }) {
  const t = useT();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-base-200/50 px-2.5 py-1.5">
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={`min-w-0 max-w-full truncate font-mono text-[12.5px] ${r.state === "off" ? "text-base-content/45 line-through" : ""}`} title={r.name}>{displaySkillName(r)}</span>
          <span className="badge badge-ghost badge-xs shrink-0">{r.scope === "missing" ? t("已不存在") : t(SCOPE_LABEL[r.scope])}</span>
          {!full && r.state !== "on" && r.state !== "off" && <span className="badge badge-info badge-outline badge-xs shrink-0">{t(STATE_LABEL[r.state])}</span>}
          {r.outside?.map((o) => (
            <span key={`${o.source}|${o.key}`} className="badge badge-warning badge-outline badge-xs shrink-0" title={`${o.key} · ${t("在 CC 自己的设置文件里设的，这里改不了")}`}>
              {t(OUTSIDE_LABEL[o.source])}: {t(STATE_LABEL[o.state as SkillState] ?? o.state)}
            </span>
          ))}
        </div>
        {r.description && <p className="mt-0.5 truncate text-[11px] text-base-content/55" title={r.description}>{r.description}</p>}
        {r.lockedBy && <p className="mt-0.5 truncate text-[11px] text-base-content/55" title={r.lockedBy}>{t("跟着整个目录一起加载，单独关不掉：")}{r.lockedBy}</p>}
      </div>
      {busy && <span className="loading loading-spinner loading-xs shrink-0" />}
      {full ? (
        <div className="join ml-auto shrink-0" role="group" aria-label={r.name}>
          {SKILL_STATES.map((s) => (
            <button
              key={s}
              title={t(STATE_HINT[s])}
              className={`btn join-item btn-xs px-1.5 font-normal ${r.state === s ? (s === "off" ? "btn-error" : "btn-primary") : "btn-ghost bg-base-100/70"}`}
              disabled={busy || readOnly}
              onClick={() => r.state !== s && onChange(s)}
            >
              {t(STATE_LABEL[s])}
            </button>
          ))}
        </div>
      ) : (
        <input
          type="checkbox"
          className="toggle toggle-sm toggle-success shrink-0"
          aria-label={r.name}
          checked={r.state !== "off"}
          disabled={busy || readOnly}
          onChange={(e) => onChange(e.target.checked ? "on" : "off")}
        />
      )}
    </li>
  );
}
