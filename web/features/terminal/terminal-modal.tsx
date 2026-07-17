"use client";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { t, useT } from "@/lib/i18n";

// xterm 依赖 window，必须 ssr:false 动态加载（设计文档 §前端）
/** dynamic loading fallback——用 useT 订阅而非模块级 t():chunk 加载窗口里切语言也能跟上 */
function TermLoading() {
  const t = useT();
  return (
    <div className="grid flex-1 place-items-center bg-[#1e1e2e] text-sm text-[#cdd6f4]/60">
      {t("加载终端…")}
    </div>
  );
}

const TerminalView = dynamic(
  () => import("./terminal-view").then((m) => m.TerminalView),
  {
    ssr: false,
    loading: () => <TermLoading />,
  }
);

/**
 * 远程终端模态框——**仅桌面**（宽屏）形态。
 *
 * 手机端不走这里：软键盘 + daisyUI 居中模态是结构性冲突（塌陷/露背/背面可滚，
 * 真机两轮实测），owner 2026-07-11 定调不再打补丁——窄屏走 TerminalPage
 * （hash 伪路由全屏页，左滑退出）。分流在 terminal-button.tsx。
 *
 * createPortal 到 body：会话页在 transform 横滑容器内（web/CLAUDE.md 规则 5.5）。
 */
export function TerminalModal({
  agent,
  displayName,
  onClose,
}: {
  agent: string;
  displayName: string;
  onClose: () => void;
}) {
  const t = useT();
  // Esc 关闭；xterm 聚焦时 Esc 被终端吃掉是预期（终端里 Esc 有语义），点 ✕ 或背板关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest?.(".xterm")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal modal-open">
      <div className="modal-box flex h-[88vh] max-h-none w-[92vw] max-w-6xl flex-col gap-0 overflow-hidden rounded-xl p-0">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#181825] px-3 py-2 text-[#cdd6f4]">
          <span className="text-sm opacity-60">🖥️</span>
          <span className="truncate text-sm font-medium">
            {t(displayName)} · {t("终端")}
          </span>
          <span className="text-xs opacity-40">
            {t("实时镜像 tmux 会话 · 关闭即断开（不影响运行）")}
          </span>
          <button
            className="btn btn-ghost btn-sm ml-auto px-2 text-[#cdd6f4]/70 hover:text-[#cdd6f4]"
            aria-label={t("关闭终端")}
            onClick={onClose}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <TerminalView agent={agent} />
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>,
    document.body
  );
}
