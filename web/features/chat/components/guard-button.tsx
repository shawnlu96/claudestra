"use client";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import { GuardPrompt, useGuardToggle } from "./guard-toggle";

/** lucide shield-check（开）/ shield（关） */
function ShieldIcon({ on }: { on: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      {on && <path d="m9 12 2 2 4-4" />}
    </svg>
  );
}

/** 会话顶栏的 Chat Guard 盾牌（owner 2026-09-28）：显示当前状态，点一下开 / 关；开不了时弹框直达设置。大总管 / mock 不给。 */
export function GuardButton({ agent }: { agent: AgentSession }) {
  const t = useT();
  const g = useGuardToggle(agent.name);
  if (agent.mock || agent.pinnedMaster) return null;
  const on = agent.chatGuard === true;
  const title = on ? t("Chat Guard 已开启：点击关闭") : t("Chat Guard 未开启：点击开启");
  return (
    <>
      <button
        className={`btn btn-ghost btn-sm px-2 ${on ? "text-success" : "text-base-content/40 hover:text-base-content"}`}
        aria-label={title}
        title={title}
        disabled={g.busy}
        onClick={() => void g.toggle(!on)}
      >
        <ShieldIcon on={on} />
      </button>
      {g.prompt && <GuardPrompt p={g.prompt} onClose={g.closePrompt} />}
    </>
  );
}
