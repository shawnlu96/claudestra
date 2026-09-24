"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";

/**
 * 输入框上方的「该重启 / 该 pi update」横幅（数据由 bridge 的 lib/update-hints.ts 算好）。
 * ✕ 只关掉**这一条**提示：版本再变（装了更新的版本）会重新出现。
 * 回合进行中不给点重启——重启会掐断正在跑的活。
 */
export function UpdateHintBanner({ agent }: { agent?: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  const [dismissed, setDismissed] = useState("");
  const [state, setState] = useState<"" | "restarting" | "failed">("");
  const hint = agent?.status === "active" ? agent.updateHint : null;
  if (!agent || !hint) return null;
  const key = `${agent.name}:${JSON.stringify(hint)}`;
  if (dismissed === key) return null;

  const restart = async () => {
    setState("restarting");
    const r = await store.restartAgent(agent.name);
    setState(r.ok ? "" : "failed");
    if (!r.ok) setTimeout(() => setState(""), 5000);
  };

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-1.5 text-xs">
      <span className="min-w-0 break-words">
        {hint.kind === "pi-update" ? (
          <>
            ⬆️ Pi {hint.latest} {t("可更新（已装")} {hint.installed}
            {t("）——在终端运行")} <code className="rounded bg-base-content/10 px-1">pi update</code>
            {t("，再重启会话")}
          </>
        ) : (
          <>
            🔄 {agent.runtime === "pi" ? "Pi" : "Claude Code"} {hint.installed} {t("已装好，本会话还在")} {hint.running}
            {t("——重启后生效")}
          </>
        )}
      </span>
      {hint.kind === "restart" && (
        <button
          className="btn btn-info btn-xs ml-auto shrink-0"
          disabled={state === "restarting" || !!agent.busy}
          title={agent.busy ? t("回合结束后再重启") : undefined}
          onClick={() => void restart()}
        >
          {state === "restarting" ? t("重启中…") : state === "failed" ? t("重启失败") : t("重启")}
        </button>
      )}
      <button
        className={`shrink-0 px-1 opacity-40 hover:opacity-80 ${hint.kind === "restart" ? "" : "ml-auto"}`}
        aria-label={t("本会话不再提示")}
        onClick={() => setDismissed(key)}
      >
        ✕
      </button>
    </div>
  );
}
