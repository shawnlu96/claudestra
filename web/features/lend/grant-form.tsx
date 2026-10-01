"use client";
/**
 * 授权表单：peer、仓库（可多个）、codex 名额、每日单数、到期档位。角色固定 review：write 开关只是一把锁，点了只抖一下、锁闪一下，
 * 永远选不中，请求体里也没有 roles（lend-model.grantBody）。提交按钮上方只放 W1 的那一句 shellSentence。
 * 失败：整张表单抖动，下面一行显示 CLI 原话；成功交回父组件让新条目淡入。
 */
import { useState } from "react";
import { ApiError } from "@/lib/api/client";
import { postGrant } from "./lend-api";
import { useLendT } from "./lend-i18n";
import { LendIcon } from "./lend-icons";
import { addRepos, canSubmit, dayChoices, grantBody, type GrantForm as Form } from "./lend-model";
import css from "./lend.module.css";

interface Props {
  peers: { name: string }[];
  maxDays: number;
  shellSentence: string;
  initial: Form;
  onDone: (peer: string) => void;
  onCancel: () => void;
}

export function GrantForm({ peers, maxDays, shellSentence, initial, onDone, onCancel }: Props) {
  const t = useLendT();
  const [f, setF] = useState<Form>(initial);
  const [repoText, setRepoText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(false);
  const [lockFlash, setLockFlash] = useState(false);
  const peerNames = peers.some((p) => p.name === f.peer) || !f.peer ? peers.map((p) => p.name) : [f.peer, ...peers.map((p) => p.name)];

  const commitRepos = () => {
    if (!repoText.trim()) return;
    setF((x) => ({ ...x, repos: addRepos(x.repos, repoText) }));
    setRepoText("");
  };
  const submit = async () => {
    const form = repoText.trim() ? { ...f, repos: addRepos(f.repos, repoText) } : f;
    if (!canSubmit(form) || busy) return void setShake(true);
    setBusy(true);
    setErr("");
    try {
      await postGrant(grantBody(form, maxDays));
      onDone(form.peer);
    } catch (e) {
      setErr(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setShake(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={css.fadeIn}>
    <div className={`space-y-3 rounded-lg bg-base-100 p-3 ${shake ? css.shake : ""}`} onAnimationEnd={() => setShake(false)}>
      <label className="flex items-center gap-2 text-xs">
        <span className="w-20 shrink-0 text-base-content/60">{t("对象")}</span>
        <select className="select select-sm min-w-0 flex-1" value={f.peer} disabled={!peerNames.length}
          onChange={(e) => setF({ ...f, peer: e.target.value })}>
          {!peerNames.length && <option value="">{t("没有可授权的 peer")}</option>}
          {peerNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      <div className="flex items-start gap-2 text-xs">
        <span className="mt-1.5 w-20 shrink-0 text-base-content/60">{t("仓库")}</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          {f.repos.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {f.repos.map((r) => (
                <span key={r} className="badge badge-sm gap-1 font-mono">
                  {r}
                  <button type="button" aria-label={`remove ${r}`} onClick={() => setF({ ...f, repos: f.repos.filter((x) => x !== r) })}>
                    <LendIcon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <input className="input input-sm min-w-0 flex-1 font-mono" placeholder="owner/repo" value={repoText}
              onChange={(e) => setRepoText(e.target.value)} onBlur={commitRepos}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitRepos(); } }} />
            <button type="button" className="btn btn-sm btn-square" aria-label={t("添加")} onClick={commitRepos}><LendIcon name="plus" /></button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="w-20 shrink-0 text-base-content/60">{t("角色")}</span>
        <span className="badge badge-sm badge-primary">{t("审查")}</span>
        <button type="button" role="switch" aria-checked="false" aria-disabled="true" aria-label={t("写代码")}
          className={`flex items-center gap-1 rounded-full bg-base-300/60 px-2 py-0.5 text-base-content/35 ${lockFlash ? css.lockFlash : ""}`}
          onClick={() => setLockFlash(true)} onAnimationEnd={(e) => { e.stopPropagation(); setLockFlash(false); }}>
          <LendIcon name="lock" size={12} />
          <span className="line-through decoration-base-content/30">{t("写代码")}</span>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-base-content/60">codex {t("名额")}</span>
          <input type="number" min={1} className="input input-sm w-full min-w-0" value={f.codex}
            onChange={(e) => setF({ ...f, codex: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-base-content/60">{t("每日单数")}</span>
          <input type="number" min={1} className="input input-sm w-full min-w-0" value={f.ordersPerDay}
            onChange={(e) => setF({ ...f, ordersPerDay: Number(e.target.value) })} />
        </label>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="w-20 shrink-0 text-base-content/60">{t("到期")}</span>
        <div className="join">
          {dayChoices(maxDays).map((d) => (
            <button key={d} type="button" className={`btn join-item btn-sm ${f.days === d ? "btn-active" : ""}`} onClick={() => setF({ ...f, days: d })}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs font-medium text-warning">{t(shellSentence)}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>{t("取消")}</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={busy}>
          {busy && <span className="loading loading-spinner loading-xs" />}
          {t("提交授权")}
        </button>
      </div>
      {err && <p className="break-words text-xs text-error">{err}</p>}
    </div>
    </div>
  );
}
