"use client";
/** 出借 Claude 直接用本机 Claude Code 登录（和本机开 worker 一样），这里只显示能不能接单；旧 setup-token 不再使用，只提示可删的位置。 */
import { useEffect, useState } from "react";
import { LendIcon } from "./lend-icons";
import { claudeLoginApi, type ClaudeLogin } from "./lend-api";
import css from "./lend.module.css";

export function LendClaudeLogin() {
  const [status, setStatus] = useState<ClaudeLogin | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void claudeLoginApi().then((s) => { if (live) setStatus(s); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const ok = status?.loggedIn === true;
  return <div className="space-y-1 rounded-lg bg-base-100 p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <LendIcon name="lock" /><span className="font-semibold">Claude 登录</span>
      {status && <span className={`${css.fadeIn} flex items-center gap-1 ${ok ? "text-success" : "text-warning"}`}>
        <LendIcon name={ok ? "circleCheck" : "circleAlert"} size={12} />{ok ? "用本机登录" : "本机不可用"}
      </span>}
      {!status && !failed && <span className="loading loading-spinner loading-xs text-base-content/40" />}
      {failed && <span className="flex items-center gap-1 text-error"><LendIcon name="circleAlert" size={12} />读取失败</span>}
    </div>
    {status && !ok && status.reason && <p className="break-words text-[11px] text-base-content/60">{status.reason}</p>}
    {status?.legacyTokenFile && <p className="break-all text-[11px] text-base-content/50">
      旧 setup-token 已不再使用，可删除 <code className="font-mono">{status.legacyTokenFile}</code></p>}
    {status?.legacyTokenEnv && <p className="text-[11px] text-base-content/50">
      环境里的 <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> 已不再使用，可从 .env 删除</p>}
  </div>;
}
