"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { useT } from "@/lib/i18n";
import { ClearAgentModal } from "./clear-agent-modal";

/** 清空：橡皮擦（lucide eraser，比扫帚干净利落） */
function EraserIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  );
}

/** 重启：循环箭头（refresh） */
function RestartIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/** 停止：电源符号（关闭该 agent） */
function PowerIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v9" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </svg>
  );
}

/** 更多操作：竖三点（ellipsis-vertical） */
function MoreIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}

/**
 * 会话详情顶栏右侧的操作区。
 * - 大总管不渲染任何操作（clear 底层能力保留，UI 不放；生命周期归 launcher）。
 * - active：清空/重启/停止收进一个 ⋮ 下拉（owner 2026-07-11：顶栏按钮太多）。
 * - 非 active：保持原样——只有恒显的重启按钮。
 * - 下拉用 daisyUI focus 模式（点外部/blur 自动收起），选项点击后主动 blur 收起。
 */
export function AgentActions({ agent }: { agent: AgentSession }) {
  const store = useChatStoreApi();
  const t = useT();
  const [busy, setBusy] = useState<"" | "kill" | "restart">("");
  const [error, setError] = useState("");
  const [showClear, setShowClear] = useState(false);

  if (agent.pinnedMaster || agent.mock) return null;

  const closeDropdown = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  const act = async (action: "kill" | "restart") => {
    if (busy) return;
    closeDropdown();
    setBusy(action);
    setError("");
    const res =
      action === "kill"
        ? await store.killAgent(agent.name)
        : await store.restartAgent(agent.name);
    setBusy("");
    if (!res.ok) {
      const raw = res.error || `${action}${t(" 失败")}`;
      // fetch 的原生失败文案对用户毫无信息量（Safari 报 "Load failed"、Chrome 报
      // "Failed to fetch"），直接钉在顶栏只会让人以为是别的东西坏了。
      const msg = /load failed|failed to fetch|networkerror|network request failed/i.test(raw)
        ? t("网络不通，请重试")
        : raw;
      setError(msg);
      // 曾经这条红字**永不消失**（只有下次点操作才清），于是一次网络抖动——比如
      // bridge 正在重启——就在顶栏永久留下一条错误，看着像系统坏了
      // （owner 2026-07-25 截图）。8 秒自动收。
      setTimeout(() => setError(""), 8000);
    }
  };

  const errorBadge = error ? (
    <span className="mr-1 max-w-40 truncate text-xs text-error" title={t(error)}>
      {t(error)}
    </span>
  ) : null;

  // 非 active：与合并前一致，只保留重启
  if (agent.status !== "active") {
    return (
      <span className="flex shrink-0 items-center gap-0.5">
        {errorBadge}
        <button
          className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content"
          title={t("重启")}
          aria-label={t("重启")}
          onClick={() => act("restart")}
          disabled={busy !== ""}
        >
          {busy === "restart" ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <RestartIcon />
          )}
        </button>
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {errorBadge}
      <div className="dropdown dropdown-end">
        <div
          tabIndex={0}
          role="button"
          aria-label={t("更多操作")}
          className={`btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content ${
            busy ? "btn-disabled" : ""
          }`}
        >
          {busy ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <MoreIcon />
          )}
        </div>
        <ul
          tabIndex={0}
          className="dropdown-content menu z-50 mt-1 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
        >
          <li>
            <button onClick={() => act("restart")} disabled={busy !== ""}>
              <RestartIcon />
              {t("重启")}
            </button>
          </li>
          <li>
            <button
              className="text-error"
              onClick={() => act("kill")}
              disabled={busy !== ""}
            >
              <PowerIcon />
              {t("停止")}
            </button>
          </li>
          {/* 清空放最下（owner 2026-07-11）：破坏性最低但最常误触，远离手指起点 */}
          <li>
            <button
              onClick={() => {
                closeDropdown();
                setShowClear(true);
              }}
              disabled={busy !== ""}
            >
              <EraserIcon />
              {t("清空")}
            </button>
          </li>
        </ul>
      </div>

      {showClear && (
        <ClearAgentModal agent={agent} onClose={() => setShowClear(false)} />
      )}
    </span>
  );
}
