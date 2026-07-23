"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { NewAgentModal } from "./new-agent-modal";
import { useT } from "@/lib/i18n";

/**
 * Agent 管理页（2026-07-14 owner：大总管做成「聊天 + UI」双轨——能点按钮
 * 解决的生命周期操作不必经过 LLM）。大总管会话顶栏「管理」进入。
 * 复用 store 的 createAgent/restartAgent/killAgent(本就是 LLM-free 的 BFF 直调);
 * 破坏性操作用行内二次确认(点一下变「确认?」,3s 复原),不弹系统框。
 *
 * 形态：全屏独立页,不是居中弹框（owner 2026-07-14 截图实锤:iOS 视口缩放/平移
 * 下居中 modal 整体歪出屏幕右缘）。fixed inset-0 不透明底 + 自垫安全区,与
 * terminal-page 同一套治法;窄屏由 chat.tsx 配 #manage hash 伪路由,左滑/返回键退出。
 */
export function ManagePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const agents = useChatStore((s) => s.state.agents);
  const store = useChatStoreApi();
  const [showNew, setShowNew] = useState(false);
  /** 待二次确认的操作 key:`restart:<name>` / `kill:<name>` */
  const [arming, setArming] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [msg, setMsg] = useState("");

  if (!open) return null;

  const arm = (key: string) => {
    setArming(key);
    setTimeout(() => setArming((v) => (v === key ? "" : v)), 3000);
  };
  const run = async (kind: "restart" | "kill", name: string) => {
    const key = `${kind}:${name}`;
    setArming("");
    setBusyKey(key);
    setMsg("");
    const r = kind === "restart" ? await store.restartAgent(name) : await store.killAgent(name);
    setBusyKey("");
    setMsg(r.ok ? `${name} ${t(kind === "restart" ? "已重启" : "已停止")}` : r.error || t("操作失败"));
  };

  const rows = agents.filter((a) => !a.pinnedMaster);

  return createPortal(
    <div className="page-fade fixed inset-0 z-[80] flex flex-col bg-base-100">
      {/* 顶栏与会话页 TopBar 同构:安全区自垫、返回箭头走 onClose(窄屏= history.back) */}
      <header
        className="flex min-h-12 shrink-0 items-center gap-1 border-b border-base-300 bg-base-100 px-3"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <button className="btn btn-ghost btn-sm -ml-1 px-2" aria-label={t("返回")} onClick={onClose}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="truncate font-semibold">{t("Agent 管理")}</span>
        <button className="btn btn-primary btn-sm ml-auto" onClick={() => setShowNew(true)}>
          {t("＋ 新建")}
        </button>
      </header>
      {msg && <div className="px-4 pt-2 text-xs text-base-content/60">{t(msg)}</div>}

      <div
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 pt-2"
        style={{
          WebkitOverflowScrolling: "touch",
          paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
        }}
      >
        <ul className="mx-auto w-full max-w-2xl space-y-1">
            {rows.map((a) => {
              const rk = `restart:${a.name}`;
              const kk = `kill:${a.name}`;
              return (
                <li key={a.name} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-base-200">
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      a.status === "stopped" ? "bg-base-content/25" : a.busy ? "bg-warning" : "bg-success"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{t(a.displayName)}</div>
                    {a.purpose && (
                      <div className="truncate text-[11px] text-base-content/40">{a.purpose}</div>
                    )}
                  </div>
                  {typeof a.contextTokens === "number" && a.contextTokens >= 200_000 && (
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-base-content/40">
                      {Math.round(a.contextTokens / 1000)}k
                    </span>
                  )}
                  <button
                    className={`btn btn-xs shrink-0 ${arming === rk ? "btn-warning" : "btn-ghost"}`}
                    disabled={busyKey !== ""}
                    onClick={() => (arming === rk ? void run("restart", a.name) : arm(rk))}
                  >
                    {busyKey === rk ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : arming === rk ? (
                      t("确认重启?")
                    ) : (
                      t("重启")
                    )}
                  </button>
                  {a.status !== "stopped" && (
                    <button
                      className={`btn btn-xs shrink-0 ${arming === kk ? "btn-error" : "btn-ghost text-error/70"}`}
                      disabled={busyKey !== ""}
                      onClick={() => (arming === kk ? void run("kill", a.name) : arm(kk))}
                    >
                      {busyKey === kk ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : arming === kk ? (
                        t("确认停止?")
                      ) : (
                        t("停止")
                      )}
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
      <NewAgentModal open={showNew} onClose={() => setShowNew(false)} />
    </div>,
    document.body
  );
}
