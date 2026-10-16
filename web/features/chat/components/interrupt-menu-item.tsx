"use client";
/**
 * 顶栏 ⋮ 里的「立即打断」（agents-ROWMORE1）：composer 暂停按钮的同一个动作——store.interrupt()
 * （3s 冷却 + POST /agents/:name/interrupt，服务端按 scope 检查、空闲不发），不发消息、不碰 kill / restart。
 * 由 topbar-actions.tsx 注入 menuLead；不带 @xl:hidden，宽顶栏也在。请求中禁用防连点；成功收起下拉，
 * 失败把原因留在这一项上（下拉不收，看得见）。store.interrupt() 打的是当前会话：点下时当前会话已不是本项
 * 渲染时的那个（切会话后的旧菜单），就不发。topbar 以 key=agent.name 挂它，切会话即重置状态。
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
      <button type="button" data-interrupt-item="" disabled={pending} aria-busy={pending} onClick={() => void run()}>
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
