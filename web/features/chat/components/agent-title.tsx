"use client";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import { ExternalBadge } from "./external-badge";

/**
 * 会话顶栏的标题（从 chat.tsx 搬出，owner 2026-09-27）：external 徽章跟在名字后面（共享给几个 peer 就挂几）；值守徽章带文字，
 * 放在 chat.tsx 的第二行徽章组（ctx 之前），否则窄屏第一行会把名字挤没。
 * 名字优先显示「显示名」（registry label），有显示名时会话名压淡跟在后面，与侧栏行「显示名 | name」一致。
 */
export function AgentTitle({ info, fallback }: { info?: AgentSession; fallback: string }) {
  const t = useT();
  if (!info) return <span className="min-w-0 truncate font-semibold">{fallback}</span>;
  return (
    <>
      <span className="min-w-0 truncate font-semibold">
        {info.label || t(info.displayName)}
        {info.label && <span className="ml-1.5 text-[12px] font-normal text-base-content/45">| {info.displayName}</span>}
      </span>
      {info.external && <ExternalBadge count={info.sharedPeers ?? 0} peers={info.sharedWith ?? []} />}
    </>
  );
}
