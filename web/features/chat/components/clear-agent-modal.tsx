"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { useT } from "@/lib/i18n";

/**
 * 清空会话确认弹窗。
 *
 * 语义分层（与 upstream 哲学对齐）：
 * - 产品层只做原生的事：远程 /clear + 会话轮转（Bridge），发一条普通消息（send）。
 * - 「开机指令」是纯用户层配置（web SQLite per-agent），clear 后作为第一条消息
 *   自动发出——知识注入（如项目图谱加载）藏在指令文本里，产品对图谱零感知。
 * - master：/clear 后 CLAUDE.md 人设自动重载，通常无需开机指令。
 */
export function ClearAgentModal({
  agent,
  onClose,
}: {
  agent: AgentSession;
  onClose: () => void;
}) {
  const t = useT();
  const store = useChatStoreApi();
  const [initMessage, setInitMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 打开时载入该 agent 已保存的开机指令
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/agents/settings?agent=${encodeURIComponent(agent.name)}`
        );
        const json = (await res.json().catch(() => ({}))) as {
          data?: { initMessage?: string };
        };
        if (!cancelled) setInitMessage(json.data?.initMessage ?? "");
      } catch {
        /* 读不到就空白 */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.name]);

  const confirm = async () => {
    setBusy(true);
    setError("");
    // 先持久化开机指令（下次 clear 还是这份）
    fetch("/api/agents/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agent.name, initMessage }),
    }).catch(() => {});
    const res = await store.clearAgent(agent.name, initMessage);
    setBusy(false);
    if (!res.ok) {
      setError(res.error || "clear 失败");
      return;
    }
    onClose();
  };

  // ⚠ 必须 portal 到 body：移动端会话页处于 transform 横滑容器内（chat.tsx
  // translate-x），CSS 规定 transform 祖先会成为 position:fixed 的定位基准——
  // 在容器里渲染 .modal（fixed）会整个定位到屏幕外一屏（点了没反应，返回列表
  // 时容器滑回来弹窗才「突然出现」）。portal 出去后 fixed 重新贴视口。
  return createPortal(
    <dialog className="modal modal-open overlay-in">
      <div className="panel-pop modal-box max-w-lg">
        <h3 className="text-base font-semibold">
          {t("🧹 清空会话")} —— {agent.displayName}
        </h3>
        <p className="mt-2 text-sm opacity-70">
          {t("远程执行 Claude Code 原生")} <code>/clear</code>
          {t("：上下文清零、会话轮转（旧会话自动归档，历史仍可回看）。进行中的回合需先「停止」。")}
        </p>

        <label className="mt-4 block text-sm font-medium">
          {t("开机指令")}
          <span className="ml-1 font-normal opacity-60">
            {t("（clear 后自动作为第一条消息发送；留空则不发）")}
          </span>
        </label>
        {agent.pinnedMaster && (
          <p className="mt-1 text-xs opacity-60">
            {t("大总管的人设由其 CLAUDE.md 自动重载，通常无需开机指令。")}
          </p>
        )}
        <textarea
          className="textarea textarea-bordered mt-2 h-40 w-full text-sm leading-relaxed"
          placeholder={loaded ? t("例如：读 xx 文件 / 加载项目上下文…") : t("加载中…")}
          value={initMessage}
          onChange={(e) => setInitMessage(e.target.value)}
          disabled={!loaded || busy}
        />

        {error && <div className="mt-2 text-sm text-error">{t(error)}</div>}

        <div className="modal-action">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </button>
          <button className="btn btn-error" onClick={confirm} disabled={busy || !loaded}>
            {busy ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              t("确认清空")
            )}
          </button>
        </div>
      </div>
      <div className="modal-backdrop" onClick={() => !busy && onClose()} />
    </dialog>,
    document.body
  );
}
