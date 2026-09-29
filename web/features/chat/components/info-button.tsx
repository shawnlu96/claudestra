"use client";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import { openAgentInfo } from "../agent-info";
import { useFullScope } from "../contacts-data";

/** lucide info */
function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/**
 * 会话顶栏的「详情」入口（owner 2026-09-27）：与侧栏右键「详情」同一个弹窗。大总管 / mock 不给（registry 里没有详情）；
 * 非全权设备也不给：/agents/:name/info 要全权，点开只有「加载失败」。
 */
export function InfoButton({ agent }: { agent: AgentSession }) {
  const t = useT();
  const full = useFullScope() === true;
  if (agent.mock || agent.pinnedMaster || !full) return null;
  return (
    <button className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content" aria-label={t("详情")} title={t("详情")} onClick={() => openAgentInfo(agent.name)}>
      <InfoIcon />
    </button>
  );
}
