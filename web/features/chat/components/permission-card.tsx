"use client";
import { useState } from "react";
import type { PendingPermission } from "../type";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";

/** action.style → daisyUI 按钮 class */
const STYLE_BTN: Record<string, string> = {
  success: "btn-success",
  primary: "btn-primary",
  danger: "btn-error",
  secondary: "btn-ghost",
};

/**
 * 权限 / session-idle 请求卡。对齐 Discord 的权限弹窗：点按钮 → BFF → Bridge 把
 * 对应 tmux 键序列打给 agent 的 Claude Code TUI（复用 bridge 的 keystroke builder）。
 */
export function PermissionCard({ p }: { p: PendingPermission }) {
  const t = useT();
  const store = useChatStoreApi();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const isIdle = p.kind === "session-idle";

  const act = async (action: string) => {
    if (busy) return;
    setBusy(action);
    setError("");
    const res = await store.resolvePermission(action);
    setBusy("");
    if (!res.ok) setError(res.error || "应答失败");
  };

  return (
    <div className="chat chat-start">
      <div className="chat-bubble max-w-[85%] overflow-hidden rounded-xl border border-warning/40 bg-warning/10 p-0 text-base-content">
        <div className="flex items-start gap-2 px-3 py-2">
          <span className="mt-0.5 text-lg">{isIdle ? "💤" : "🔔"}</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-warning">
              {isIdle ? t("会话已闲置，Claude Code 询问如何继续") : t("需要授权")}
            </div>
            {(p.desc || p.title) && (
              <div className="mt-0.5 whitespace-pre-wrap break-words text-xs opacity-70">
                {t(p.desc || p.title || "")}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {p.actions.map((a) => (
            <button
              key={a.action}
              className={`btn btn-xs ${STYLE_BTN[a.style] || "btn-ghost"}`}
              disabled={busy !== ""}
              onClick={() => act(a.action)}
            >
              {busy === a.action ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                t(a.label)
              )}
            </button>
          ))}
        </div>
        {error && (
          <div className="px-3 pb-2 text-xs text-error break-words">{t(error)}</div>
        )}
      </div>
    </div>
  );
}
