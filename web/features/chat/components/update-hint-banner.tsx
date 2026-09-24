"use client";
import { useState, useSyncExternalStore } from "react";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import {
  dismissUpdateHint, getDismissedHints, getDismissedHintsServer, subscribeDismissedHints, updateHintKey,
} from "../update-hint-dismiss";

/** 这条提示被关过没有（横幅与侧栏 ⬆ 共用：关掉横幅，侧栏小标一起消失） */
export function useUpdateHintDismissed(agent: Pick<AgentSession, "name" | "updateHint"> | undefined): boolean {
  const set = useSyncExternalStore(subscribeDismissedHints, getDismissedHints, getDismissedHintsServer);
  return !!agent?.updateHint && set.has(updateHintKey(agent.name, agent.updateHint));
}

/**
 * 输入框上方的「该重启 / 该 pi update」横幅（数据由 bridge 的 lib/update-hints.ts 算好）。
 * ✕ 只关掉**这个版本**的提示（持久化，见 update-hint-dismiss.ts）：装了更新的版本会重新出现。
 * 回合进行中不给点重启——重启会掐断正在跑的活。
 */
export function UpdateHintBanner({ agent }: { agent?: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  // 按 agent 记：横幅组件跨会话复用，不记名的话 A 在重启中、切到 B 也会显示「重启中…」
  const [restart, setRestart] = useState<{ agent: string; state: "restarting" | "failed" } | null>(null);
  const dismissed = useUpdateHintDismissed(agent);
  const hint = agent?.status === "active" ? agent.updateHint : null;
  if (!agent || !hint || dismissed) return null;
  const state = restart?.agent === agent.name ? restart.state : "";

  const doRestart = async () => {
    const name = agent.name;
    setRestart({ agent: name, state: "restarting" });
    const r = await store.restartAgent(name);
    const keep = (cur: typeof restart) => cur?.agent !== name; // 期间又点了别的会话的重启：别覆盖它的状态
    setRestart((cur) => (keep(cur) ? cur : r.ok ? null : { agent: name, state: "failed" }));
    if (!r.ok) setTimeout(() => setRestart((cur) => (keep(cur) ? cur : null)), 5000);
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
            🔄 {agent.runtime === "pi" ? "Pi" : agent.runtime === "codex" ? "Codex" : "Claude Code"} {hint.installed} {t("已装好，本会话还在")} {hint.running}
            {t("——重启后生效")}
          </>
        )}
      </span>
      {hint.kind === "restart" && (
        <button
          className="btn btn-info btn-xs ml-auto shrink-0"
          disabled={state === "restarting" || !!agent.busy}
          title={agent.busy ? t("回合结束后再重启") : undefined}
          onClick={() => void doRestart()}
        >
          {state === "restarting" ? t("重启中…") : state === "failed" ? t("重启失败") : t("重启")}
        </button>
      )}
      <button
        className={`shrink-0 px-1 opacity-40 hover:opacity-80 ${hint.kind === "restart" ? "" : "ml-auto"}`}
        aria-label={t("这个版本不再提示")}
        title={t("这个版本不再提示")}
        onClick={() => dismissUpdateHint(updateHintKey(agent.name, hint))}
      >
        ✕
      </button>
    </div>
  );
}
