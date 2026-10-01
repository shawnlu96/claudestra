"use client";
import { useEffect, useState } from "react";
import { ClaudeCopyIcon } from "./lend-claude-icons";
import { LendIcon } from "./lend-icons";
import { claudeTokenApi } from "./lend-api";
import css from "./lend.module.css";
interface Status { configured: boolean; savedAt: string | null }

export function LendClaudeLogin() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<"ok" | "error" | null>(null);
  useEffect(() => {
    let live = true;
    void claudeTokenApi().then((s) => { if (live) setStatus(s); }, () => { if (live) setFeedback("error"); });
    return () => { live = false; };
  }, []);
  const act = async (clear = false) => {
    setBusy(true);
    setFeedback(null);
    try {
      setStatus(await claudeTokenApi(clear ? "DELETE" : "POST", clear ? undefined : token));
      setToken("");
      setFeedback("ok");
    } catch {
      // Feedback stays generic so a server/proxy error cannot display submitted credentials.
      setFeedback("error");
    } finally { setBusy(false); }
  };
  return <div className={`space-y-2 rounded-lg bg-base-100 p-3 ${feedback === "error" ? css.shake : ""}`}
    onAnimationEnd={() => setFeedback(null)}>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <LendIcon name="lock" /><span className="font-semibold">Claude 登录</span>
      <span className="text-base-content/50">{status?.configured ? "已配置" : "未配置"}</span>
      {status?.savedAt && <time className="text-base-content/40">{new Date(status.savedAt).toLocaleString()}</time>}
      {feedback === "ok" && <LendIcon name="check" className={`${css.fadeIn} text-success`} />}
    </div>
    <button type="button" className="btn btn-ghost btn-xs gap-2 font-mono" onClick={() => {
      setFeedback(null);
      void navigator.clipboard.writeText("claude setup-token").then(() => setFeedback("ok"), () => setFeedback("error"));
    }}><ClaudeCopyIcon />claude setup-token</button>
    <div className="flex gap-2">
      <input type="password" autoComplete="off" aria-label="Claude setup-token" placeholder="setup-token"
        className="input input-sm min-w-0 flex-1" value={token} onChange={(e) => setToken(e.target.value)} disabled={busy} />
      <button type="button" className="btn btn-sm btn-square" aria-label="保存 Claude token" disabled={busy || !token.trim()} onClick={() => void act()}>
        {busy ? <span className="loading loading-spinner loading-xs" /> : <LendIcon name="check" />}
      </button>
      <button type="button" className="btn btn-sm btn-square" aria-label="清除 Claude token" disabled={busy || !status?.configured} onClick={() => void act(true)}>
        <LendIcon name="x" />
      </button>
    </div>
  </div>;
}
