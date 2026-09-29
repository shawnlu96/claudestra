"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat/chat-store";
import { useChatNav } from "../chat/components/nav-context";
import { uiAgentName } from "@/lib/chat/agents";
import { closeCollab } from "./collab-nav";
import type { LedgerOverview } from "./collab-model";
import { TeamPanelCards } from "./team-panel-cards";
import { useTeamPanel } from "./use-team-panel";
import { useTeamActivity } from "./use-team-activity";
import { useTeamT } from "./team-panel-i18n";
import { nodePositions, teamNodes, visibleInteractions } from "./team-graph-model";
import { TeamGraphNode, TeamGraphEdges, TeamActivityList } from "./team-graph-parts";
import s from "./team-graph.module.css";

/** Self-contained team view: T58 can mount this without depending on the temporary CollabView position. */
export function TeamPanel({ ov, project }: { ov: LedgerOverview | null; project: string }) {
  const t = useTeamT();
  const data = useTeamPanel();
  const activity = useTeamActivity(project);
  const store = useChatStoreApi();
  const nav = useChatNav();
  const [selected, setSelected] = useState<string | null>(null);
  const nodes = teamNodes(data.agents ?? [], data.peers ?? [], ov?.meta.pms ?? []);
  for (const node of nodes) {
    const roles = activity?.roles?.filter((r) => r.id === node.id).map((r) => r.role) ?? [];
    if (node.role === "agent" && roles.length) node.role = [...new Set(roles)].join(" / ");
  }
  const positions = nodePositions(nodes);
  const events = visibleInteractions(activity?.interactions ?? [], nodes, activity?.now ?? Date.now());
  const shown = nodes.find((n) => n.id === selected);
  const height = Math.max(290, Math.ceil(nodes.length / 3) * 235 + 20);
  const jump = () => { if (shown?.agent) { closeCollab(); void store.openAgent(uiAgentName(shown.agent.name)); nav.toContent(); } };
  return <section className={s.panel} aria-label={t("团队")}>
    <header className={s.header}><div><h2>{t("团队")}</h2><p>{t("最近 10 分钟 · 只显示已记录的真实往来")}</p></div>
      <span>{nodes.length} {t("成员")}</span></header>
    <div className={s.scroller}>
      <div className={s.canvas} style={{ height }}>
        <TeamGraphEdges events={events} positions={positions} height={height} />
        {nodes.map((node) => <div key={node.id} className={s.slot} style={{ left: positions.get(node.id)!.x, top: positions.get(node.id)!.y }}>
          <TeamGraphNode node={node} quotas={data.quotas ?? []} selected={selected === node.id} onSelect={() => setSelected(node.id)} />
        </div>)}
      </div>
    </div>
    <div className={s.mobile}>{nodes.map((node) => <TeamGraphNode key={node.id} node={node} quotas={data.quotas ?? []}
      selected={selected === node.id} onSelect={() => setSelected(node.id)} />)}</div>
    <TeamActivityList events={events} nodes={nodes} unavailable={!activity} truncated={activity?.truncated ?? false} />
    <p className={s.hint}>{t("缺少收件人的交付和审查只列记录，不推测连线。外部 PM、模型、额度未提供时为未知。")}</p>
    {shown && <div className={s.selection}>
      {shown.agent && <button type="button" className={s.link} onClick={jump}>{t("打开会话")} → {shown.name}</button>}
      <TeamPanelCards key={`${project}/${shown.id}`} project={project} peer={shown.peer ?? ""} agent={shown.name} />
    </div>}
  </section>;
}
