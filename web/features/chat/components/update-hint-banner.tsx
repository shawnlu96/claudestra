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
 * 按钮：restart → 重启该会话；pi-update → bridge 替你跑 `pi update` 再重启该会话（要一两分钟）。
 * ✕ 只关掉**这个版本**的提示（持久化，见 update-hint-dismiss.ts）：装了更新的版本会重新出现。
 * 回合进行中不给点——两种按钮最后都要重启，会掐断正在跑的活。
 */
export function UpdateHintBanner({ agent }: { agent?: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  // 按 agent 记：横幅组件跨会话复用，不记名的话 A 在重启中、切到 B 也会显示「重启中…」
  const [run, setRun] = useState<{ agent: string; state: "running" | "failed"; error?: string } | null>(null);
  const dismissed = useUpdateHintDismissed(agent);
  const hint = agent?.status === "active" ? agent.updateHint : null;
  if (!agent || !hint || dismissed) return null;
  const mine = run?.agent === agent.name ? run : null;
  const piUpdate = hint.kind === "pi-update";

  const act = async () => {
    const name = agent.name;
    setRun({ agent: name, state: "running" });
    const r = piUpdate ? await store.lifecycleAction("pi-update", name) : await store.restartAgent(name);
    const keep = (cur: typeof run) => cur?.agent !== name; // 期间又点了别的会话：别覆盖它的状态
    setRun((cur) => (keep(cur) ? cur : r.ok ? null : { agent: name, state: "failed", error: r.error }));
    if (!r.ok) setTimeout(() => setRun((cur) => (keep(cur) ? cur : null)), 8000);
  };
  const label = mine?.state === "running"
    ? t(piUpdate ? "更新中…" : "重启中…")
    : mine?.state === "failed" ? t(piUpdate ? "更新失败" : "重启失败") : t(piUpdate ? "更新并重启" : "重启");

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-1.5 text-xs">
      <span className="min-w-0 break-words">
        {piUpdate ? (
          <>
            ⬆️ Pi {hint.latest} {t("可更新（已装")} {hint.installed}
            {t("）")}
          </>
        ) : (
          <>
            🔄 {agent.runtime === "pi" ? "Pi" : agent.runtime === "codex" ? "Codex" : "Claude Code"} {hint.installed} {t("已装好，本会话还在")} {hint.running}
            {t("——重启后生效")}
          </>
        )}
        {mine?.error && <span className="mt-0.5 block text-error">{mine.error}</span>}
      </span>
      <button
        className="btn btn-info btn-xs ml-auto shrink-0"
        disabled={mine?.state === "running" || !!agent.busy}
        title={agent.busy ? t("回合结束后再重启") : undefined}
        onClick={() => void act()}
      >
        {label}
      </button>
      <button
        className="shrink-0 px-1 opacity-40 hover:opacity-80"
        aria-label={t("这个版本不再提示")}
        title={t("这个版本不再提示")}
        onClick={() => dismissUpdateHint(updateHintKey(agent.name, hint))}
      >
        ✕
      </button>
    </div>
  );
}
