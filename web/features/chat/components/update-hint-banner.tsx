"use client";
import { useState, useSyncExternalStore } from "react";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import { useFullScope } from "../contacts-data";
import {
  dismissUpdateHint, getDismissedHints, getDismissedHintsServer, subscribeDismissedHints, updateHintKey,
} from "../update-hint-dismiss";

/** 这条提示被关过没有（横幅与侧栏 ⬆ 共用：关掉横幅，侧栏小标一起消失） */
export function useUpdateHintDismissed(agent: Pick<AgentSession, "name" | "updateHint"> | undefined): boolean {
  const set = useSyncExternalStore(subscribeDismissedHints, getDismissedHints, getDismissedHintsServer);
  return !!agent?.updateHint && set.has(updateHintKey(agent.name, agent.updateHint));
}

/**
 * 输入框上方的「该重启 / 该更新 Pi·Codex」横幅（数据由 bridge 的 lib/update-hints.ts 算好）。
 * 按钮：restart → 重启该会话；pi-update / codex-update → bridge 替你更新再重启该会话（要一两分钟）。
 * Codex 不是 npm 全局安装、或目标版本不在 codex-acp 配套范围（adapterPairs）时：只给文字，不给按钮。
 * ✕ 只关掉**这个版本**的提示（持久化，见 update-hint-dismiss.ts）：装了更新的版本会重新出现。
 * 回合进行中不给点——两种按钮最后都要重启，会掐断正在跑的活。
 */
export function UpdateHintBanner({ agent }: { agent?: AgentSession }) {
  const t = useT();
  const store = useChatStoreApi();
  // 按 agent 记：横幅组件跨会话复用，不记名的话 A 在重启中、切到 B 也会显示「重启中…」
  const [run, setRun] = useState<{ agent: string; state: "running" | "failed"; error?: string } | null>(null);
  const dismissed = useUpdateHintDismissed(agent);
  const full = useFullScope() === true; // 两种按钮最后都是重启，要全权凭据；别的设备看到了也点不动
  const hint = agent?.status === "active" ? agent.updateHint : null;
  if (!agent || !hint || dismissed || !full) return null;
  const mine = run?.agent === agent.name ? run : null;
  const update = hint.kind === "restart" ? null : hint;
  const updLabel = hint.kind === "codex-update" ? "Codex" : "Pi";

  const act = async () => {
    const name = agent.name;
    setRun({ agent: name, state: "running" });
    const r = update ? await store.lifecycleAction(update.kind, name) : await store.restartAgent(name);
    const keep = (cur: typeof run) => cur?.agent !== name; // 期间又点了别的会话：别覆盖它的状态
    setRun((cur) => (keep(cur) ? cur : r.ok ? null : { agent: name, state: "failed", error: r.error }));
    if (!r.ok) setTimeout(() => setRun((cur) => (keep(cur) ? cur : null)), 8000);
  };
  const label = mine?.state === "running"
    ? t(update ? "更新中…" : "重启中…")
    : mine?.state === "failed" ? t(update ? "更新失败" : "重启失败") : t(update ? "更新并重启" : "重启");
  // Codex 目标版本不在 codex-acp 配套范围（adapterPairs）时 bridge 端点也会拒：只给文字
  const pairs = hint.kind === "pi-update" ? undefined : hint.adapterPairs;
  const manualOnly = !!pairs || (update?.kind === "codex-update" && !update.npm);

  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-1.5 text-xs">
      <span className="min-w-0 break-words">
        {hint.kind !== "restart" ? (
          <>
            ⬆️ {updLabel} {hint.latest} {t("可更新（已装")} {hint.installed}
            {t("）")}
            {manualOnly && !pairs && t("（不是 npm 全局安装，请用原来的方式更新）")}
          </>
        ) : (
          <>
            🔄 {agent.runtime === "pi" ? "Pi" : agent.runtime === "codex" ? "Codex" : "Claude Code"} {hint.installed} {t("已装好，本会话还在")} {hint.running}
            {t("——重启后生效")}
          </>
        )}
        {pairs && (
          <>
            {t("（ACP 适配器只配套")} {pairs}
            {t(update ? "，等适配器升级后再更新）" : "，重启前先对齐版本）")}
          </>
        )}
        {mine?.error && <span className="mt-0.5 block text-error">{mine.error}</span>}
      </span>
      {!manualOnly && <button
        className="btn btn-info btn-xs ml-auto shrink-0"
        disabled={mine?.state === "running" || !!agent.busy}
        title={agent.busy ? t("回合结束后再重启") : undefined}
        onClick={() => void act()}
      >
        {label}
      </button>}
      <button
        className={`shrink-0 px-1 opacity-40 hover:opacity-80${manualOnly ? " ml-auto" : ""}`}
        aria-label={t("这个版本不再提示")}
        title={t("这个版本不再提示")}
        onClick={() => dismissUpdateHint(updateHintKey(agent.name, hint))}
      >
        ✕
      </button>
    </div>
  );
}
