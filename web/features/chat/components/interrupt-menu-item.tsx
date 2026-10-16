"use client";
/**
 * 复用 composer 的 store.interrupt()，沿用冷却和服务端保护。topbar 按 agent.name 重挂，旧菜单不打断新会话。
 * 请求期间用 aria-disabled + pending 闸防连点，保留按钮焦点；原生 disabled 会关闭依赖 focus-within 的菜单，
 * 把失败提示藏起来。成功才主动失焦收起，失败留在原项（真浏览器覆盖见 web-row-more-browser.test.ts）。
 */
import { useEffect, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { useT } from "@/lib/i18n";
import { closeDropdown } from "./agent-actions";

/** 哪些会话给「立即打断」：active、非 mock（大总管、受限设备上获授权的会话一样给，不要求全权） */
export function canInterrupt(agent: AgentSession): boolean {
  return agent.status === "active" && !agent.mock;
}

/** lucide octagon-x：停止当前这一轮（与「停止」会话的电源符号区分开） */
function InterruptIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 9-6 6" />
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

const NET = /load failed|failed to fetch|networkerror|network request failed/i;

export function InterruptMenuItem({ agent }: { agent: AgentSession }) {
  const store = useChatStoreApi();
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(""), 8000);
    return () => clearTimeout(id);
  }, [error]);
  if (!canInterrupt(agent)) return null;
  const run = async () => {
    if (pending) return;
    if (store.state.activeAgent !== agent.name) {
      closeDropdown();
      return;
    }
    setPending(true);
    setError("");
    const res = await store.interrupt().catch((e: Error) => ({ ok: false, error: e.message }));
    setPending(false);
    if (res.ok) closeDropdown();
    else setError(NET.test(res.error ?? "") ? "网络不通，请重试" : res.error || "操作失败");
  };
  return (
    <li>
      <button type="button" data-interrupt-item="" aria-disabled={pending} aria-busy={pending} onClick={() => void run()}>
        {pending ? <span className="loading loading-spinner loading-xs" /> : <InterruptIcon />}
        {t("立即打断")}
      </button>
      {error && (
        <span role="alert" className="pointer-events-none whitespace-normal px-3 pb-1 text-xs text-error">
          {t(error)}
        </span>
      )}
    </li>
  );
}
