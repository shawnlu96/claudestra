"use client";
/** Grants expose per-family slots, repositories and expiry; failures shake the form. */
import { useState } from "react";
import { postGrant } from "./lend-api";
import { useLendT } from "./lend-i18n";
import { LendIcon } from "./lend-icons";
import { switchClaudeGrantPeer, addRepos, canSubmit, dayChoices, grantBody, type GrantForm as Form, type GrantView } from "./lend-model";
import css from "./lend.module.css";

interface Props {
  peers: { name: string }[];
  grants: readonly GrantView[];
  maxDays: number;
  initial: Form;
  onDone: (peer: string) => void;
  /** 失败也让父组件重拉：CLI 停 worker 超时被强杀时授权其实已写进 lend.json */
  onFail: () => void;
  onCancel: () => void;
}

/** 仓库：已加的是徽章（可删），输入框回车 / 逗号 / 失焦即加 */
function RepoField({ repos, text, setText, onCommit, onRemove }: {
  repos: string[]; text: string; setText: (v: string) => void; onCommit: () => void; onRemove: (r: string) => void;
}) {
  const t = useLendT();
  return (
      <div className="flex items-start gap-2 text-xs">
        <span className="mt-1.5 w-20 shrink-0 text-base-content/60">{t("仓库")}</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          {repos.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {repos.map((r) => (
                <span key={r} className="badge badge-sm gap-1 font-mono">
                  {r}
                  <button type="button" aria-label={`remove ${r}`} onClick={() => onRemove(r)}>
                    <LendIcon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <input className="input input-sm min-w-0 flex-1 font-mono" placeholder="owner/repo" value={text}
              onChange={(e) => setText(e.target.value)} onBlur={onCommit}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); onCommit(); } }} />
            <button type="button" className="btn btn-sm btn-square" aria-label={t("添加")} onClick={onCommit}><LendIcon name="plus" /></button>
          </div>
        </div>
      </div>
  );
}

export function GrantForm({ peers, grants, maxDays, initial, onDone, onFail, onCancel }: Props) {
  const t = useLendT();
  const start = switchClaudeGrantPeer(initial, initial.peer, grants, maxDays);
  const [f, setF] = useState<Form>(start.form);
  const [baseline, setBaseline] = useState<Form | undefined>(start.baseline);
  const [repoText, setRepoText] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
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
    try {
      await postGrant(grantBody(form, maxDays, baseline));
      onDone(form.peer);
    } catch {
      // Keep the draft and report failure with motion; reloading confirms any completed CLI write.
      setShake(true);
      onFail();
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
          onChange={(e) => { const next = switchClaudeGrantPeer(f, e.target.value, grants, maxDays); setF(next.form); setBaseline(next.baseline); }}>
          {!peerNames.length && <option value="">{t("没有可授权的 peer")}</option>}
          {peerNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      <RepoField repos={f.repos} text={repoText} setText={setRepoText} onCommit={commitRepos}
        onRemove={(r) => setF({ ...f, repos: f.repos.filter((x) => x !== r) })} />

      <div className="grid grid-cols-2 gap-3 text-xs">
        {(["claude", "codex"] as const).map((family) => (
          <label key={family} className="flex min-w-0 flex-col gap-1">
            <span className="text-base-content/60">{family === "claude" ? "Claude" : "Codex"} {t("名额")}</span>
            <input type="number" min={0} max={16} step={1} aria-label={`${family === "claude" ? "Claude" : "Codex"} ${t("名额")}`}
              className="input input-sm w-full min-w-0" value={f[family] ?? 0} disabled={busy}
              onChange={(e) => setF({ ...f, [family]: Number(e.target.value) })} />
          </label>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="w-20 shrink-0 text-base-content/60">{t("到期")}</span>
        <div className="join">
          {dayChoices(maxDays).map((d) => (
            <button key={d} type="button" className={`btn join-item btn-sm ${f.days === d ? "btn-primary" : ""}`} onClick={() => setF({ ...f, days: d })}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>{t("取消")}</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={busy}>
          {busy && <span className="loading loading-spinner loading-xs" />}
          {t("提交授权")}
        </button>
      </div>
    </div>
    </div>
  );
}
