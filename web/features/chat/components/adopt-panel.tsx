"use client";
import { useState } from "react";
import { ApiError } from "@/lib/api/client";
import { resumeSession } from "@/lib/api/agents";
import { useT } from "@/lib/i18n";
import type { SubSessionInfo } from "@/lib/session-nesting";

/**
 * 会话视图底部的「收编为 agent」：起名 → 收编。子会话（Codex 的 subagent / 自动审查线程）先过一道确认——
 * 它们是主会话派生出来的，单独收编基本是误操作（owner 就这么收编过一条自动审查线程）。确认后照样能收编；
 * bridge 也认子会话（没带 confirmSubSession 回 409 + 归属），界面没标出来的子会话在这里补上确认。
 */
export function AdoptPanel({ session, parentName, onCancel, onAccepted, onError }: {
  session: { sessionId: string; slug: string; runtime: string; cwd: string; sub?: SubSessionInfo };
  parentName?: string;
  onCancel: () => void;
  onAccepted: (hint: string) => void;
  onError: (msg: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(session.slug || session.sessionId.slice(0, 8));
  const [busy, setBusy] = useState(false);
  // 待确认的子会话归属：界面已知是子会话就先问；bridge 回 409 说是子会话也转到这一步
  const [pendingSub, setPendingSub] = useState<SubSessionInfo | null>(session.sub ?? null);
  const [confirmed, setConfirmed] = useState(false);

  const adopt = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const body = { agent: n, sessionId: session.sessionId, runtime: session.runtime, cwd: session.cwd, ...(confirmed ? { confirmSubSession: true } : {}) };
      const json = (await resumeSession(body)) as { hint?: string };
      onAccepted(json.hint || t("已受理，正在后台收编（约 10-40 秒），完成后会出现在 agent 列表里。"));
    } catch (e) {
      const sub = e instanceof ApiError ? (e.body as { subSession?: SubSessionInfo } | null)?.subSession : undefined;
      if (sub && !confirmed) setPendingSub(sub);
      else onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (pendingSub && !confirmed) {
    const parent = parentName || pendingSub.parentId.slice(0, 8) || t("另一个会话");
    const what = pendingSub.kind === "guardian_review" ? t("自动审查线程") : t("子会话");
    return (
      <div className="flex flex-col gap-2" role="alertdialog" aria-label={t("确认收编子会话")}>
        <div className="rounded-lg bg-warning/15 px-3 py-2 text-xs text-base-content/80">
          {t("这是「{parent}」的{what}，通常不需要单独收编——它会跟着主会话走。确定要把它单独收编成 agent 吗？", { parent, what })}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t("取消")}
          </button>
          <button className="btn btn-warning btn-sm" onClick={() => setConfirmed(true)}>
            {t("仍然收编")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="input input-bordered input-sm flex-1"
        placeholder={t("agent 名字")}
        value={name}
        disabled={busy}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void adopt();
        }}
      />
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void adopt()}>
        {busy ? <span className="loading loading-spinner loading-xs" /> : null}
        {t("收编")}
      </button>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
        {t("取消")}
      </button>
    </div>
  );
}
