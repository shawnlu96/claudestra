"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat/chat-store";
import { useChatNav } from "../chat/components/nav-context";
import { useMachineFp } from "../talk/use-talk";
import { uiAgentName } from "@/lib/chat/agents";
import { metaOf } from "@/lib/ledger-meta-guard";
import { closeCollab } from "./collab-nav";
import type { LedgerOverview } from "./collab-model";
import type { TeamAgent } from "./team-panel-model";
import { TeamPanelCards } from "./team-panel-cards";
import { useTeamPanel } from "./use-team-panel";
import { useTeamActivity } from "./use-team-activity";
import { useTeamWidth } from "./use-team-width";
import { useTeamT } from "./team-panel-i18n";
import { nodePositions, teamNodes, TEAM_ROW_HEIGHT, visibleInteractions, type TeamNode } from "./team-graph-model";
import { TeamGraphNode, TeamGraphEdges, TeamActivityList } from "./team-graph-parts";
import s from "./team-graph.module.css";

export interface TeamPanelProps {
  ov: LedgerOverview | null; project: string; agents: readonly TeamAgent[];
  /** Server epoch milliseconds, never the browser's wall clock. */
  now: number; embedded?: boolean; selected?: string | null; onSelect?: (node: TeamNode) => void;
  /** The source has no local members (team view): render nothing, so /peers/contacts, /team/quota and /team/activity are never read. */
  unavailable?: boolean;
}

export function TeamPanel({ unavailable, ...props }: TeamPanelProps) {
  return unavailable ? null : <LocalTeamPanel {...props} />;
}

/** Embedded selection belongs to the host's inspector; standalone keeps its own task section. */
function LocalTeamPanel({ ov, project, agents, now, embedded = false, selected, onSelect }: Omit<TeamPanelProps, "unavailable">) {
  const t = useTeamT();
  const data = useTeamPanel();
  const activity = useTeamActivity(project);
  const fp = useMachineFp();
  const scope = JSON.stringify([fp, project]);
  const serverNow = activity?.now ?? now;
  const { ref, width } = useTeamWidth();
  const store = useChatStoreApi();
  const nav = useChatNav();
  const [selection, setSelection] = useState<{ scope: string; id: string } | null>(null);
  const current = selected !== undefined ? selected : selection?.scope === scope ? selection.id : null;
  const nodes = teamNodes(agents, data.peers ?? [], metaOf(ov).pms).map((node) => {
    const roles = activity?.roles?.filter((r) => r.id === node.id).map((r) => r.role) ?? [];
    return node.role === "agent" && roles.length ? { ...node, role: [...new Set(roles)].join(" / ") } : node;
  });
  const positions = nodePositions(nodes, width);
  const events = visibleInteractions(activity?.interactions ?? [], nodes, serverNow);
  const shown = nodes.find((n) => n.id === current);
  const height = Math.max(290, ...[...positions.values()].map((p) => p.y + TEAM_ROW_HEIGHT));
  const choose = (node: TeamNode) => { if (selected === undefined) setSelection({ scope, id: node.id }); onSelect?.(node); };
  const jump = () => { if (shown?.agent) { closeCollab(); void store.openAgent(uiAgentName(shown.agent.name)); nav.toContent(); } };
  return <section ref={ref} className={embedded ? s.embedded : s.panel} aria-label={t("团队")}>
    {!embedded && <header className={s.header}><div><h2>{t("团队")}</h2><p>{t("最近 10 分钟 · 只显示已记录的真实往来")}</p></div>
      <span>{nodes.length} {t("成员")}</span></header>}
    <div className={s.scroller}>
      <div className={s.canvas} style={{ height }}>
        <TeamGraphEdges events={events} positions={positions} height={height} width={width} scope={scope} now={serverNow} />
        {nodes.map((node) => <div key={node.id} className={s.slot}
          style={{ left: positions.get(node.id)!.x, top: positions.get(node.id)!.y, width: positions.get(node.id)!.width }}>
          <TeamGraphNode node={node} quotas={data.quotas ?? []} now={serverNow} selected={current === node.id} onSelect={() => choose(node)} />
        </div>)}
      </div>
    </div>
    <div className={s.mobile}>{nodes.map((node) => <TeamGraphNode key={node.id} node={node} quotas={data.quotas ?? []}
      now={serverNow} selected={current === node.id} onSelect={() => choose(node)} />)}</div>
    <TeamActivityList events={events} nodes={nodes} unavailable={!activity} truncated={activity?.truncated ?? false} />
    <p className={s.hint}>{t("缺少收件人的交付和审查只列记录，不推测连线。外部 PM、模型、额度未提供时为未知。")}</p>
    {activity?.gaps?.includes("delivery_ring_not_persistent") && <p className={s.hint}>{t("消息记录仅保留本次启动后的有限窗口。")}</p>}
    {!embedded && shown && <div className={s.selection}>
      {shown.agent && <button type="button" className={s.link} onClick={jump}>{t("打开会话")} → {shown.name}</button>}
      <TeamPanelCards key={scope + shown.id} project={project} peer={shown.peer ?? ""} agent={shown.name} />
    </div>}
  </section>;
}
