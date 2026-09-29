"use client";
import { useEffect, useId, useRef } from "react";
import { contextText, peerWorkState, quotaTier, workState, type TeamQuota } from "./team-panel-model";
import type { Interaction, TeamNode } from "./team-graph-model";
import { useTeamT } from "./team-panel-i18n";
import s from "./team-graph.module.css";
import { claimTeamAnimation, teamEdgeLane } from "./team-animation";

const STATUS = { busy: "忙", idle: "空闲", stopped: "已停止", unknown: "未知", available: "能接", closed: "不接" };
const KIND = { assign: "派活", dispatch: "派审", deliver: "交付", review: "审查结论", message: "消息" };
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function TeamGraphNode({ node: n, quotas, selected, onSelect, now }: {
  node: TeamNode; quotas: TeamQuota[]; selected: boolean; onSelect: () => void; now: number;
}) {
  const t = useTeamT();
  const state = n.agent ? workState(n.agent) : n.presence && n.remote ? peerWorkState(n.presence, n.remote, now) : "unknown";
  const provider = n.agent?.runtime === "codex" ? "codex" : n.agent?.runtime === "claude-code" ? "claude" : null;
  const q = quotas.find((q) => q.provider === provider);
  const role = n.role === "owner" ? "你" : n.role === "master" ? "大总管" : n.role === "agent" ? "成员" : n.role;
  return <button type="button" className={s.node} aria-pressed={selected} onClick={onSelect}>
    <span className={s.nodeHead}><span>{t(role)}</span><span className={`${s.badge} ${s[state]}`}>{t(STATUS[state])}</span></span>
    <strong>{n.name}</strong>
    <span className={s.source}>{n.peer ?? t("本机")}{n.presence ? ` · ${t(n.presence.online === true ? "在线" : n.presence.online === false ? "离线" : "未知")}` : ""}</span>
    <span className={s.detail}>{n.agent?.model || n.agent?.runtime || t("未知")}</span>
    <span className={s.detail}>{t("额度")} · {t(STATUS[q ? quotaTier(q, now) : "unknown"])}
      {" / "}{t("上下文")} · {contextText(n.agent?.contextTokens) ?? t("未知")}</span>
  </button>;
}

function TeamEdge({ event, scope, now, children }: { event: Interaction; scope: string; now: number; children: React.ReactNode }) {
  const ref = useRef<SVGGElement>(null);
  useEffect(() => {
    if (claimTeamAnimation(scope, event.id, event.at, now)) ref.current?.classList.add(s.arrival);
  }, [scope, event.id, event.at, now]);
  return <g ref={ref} className={s.edge}>{children}</g>;
}

export function TeamGraphEdges({ events, positions, height, width, scope, now }: {
  events: Interaction[]; positions: Map<string, { x: number; y: number; width: number }>; height: number; width: number; scope: string; now: number;
}) {
  const t = useTeamT();
  const arrow = useId().replace(/:/g, "");
  const edges = events.filter((e) => e.to && e.to !== e.from && positions.has(e.from) && positions.has(e.to)).slice(0, 40);
  return <svg className={s.edges} width={width} height={height} aria-hidden="true">
    <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
    {edges.map((e) => {
      const a = positions.get(e.from), b = positions.get(e.to!);
      if (!a || !b) return null;
      const x1 = a.x + a.width / 2, y1 = a.y + 170, x2 = b.x + b.width / 2, y2 = b.y;
      const lane = Math.max(y1, y2) + 22 + teamEdgeLane(e.id) * 15;
      return <TeamEdge key={e.id} event={e} scope={scope} now={now}>
        <path d={`M ${x1} ${y1} C ${x1} ${lane}, ${x2} ${lane}, ${x2} ${y2}`} markerEnd={`url(#${arrow})`} />
        <text x={(x1 + x2) / 2} y={lane - 3} textAnchor="middle">{t(KIND[e.kind])}{e.task ? ` · ${e.task}` : ""} · {time(e.at)}</text>
      </TeamEdge>;
    })}
  </svg>;
}

export function TeamActivityList({ events, nodes, unavailable, truncated }: {
  events: Interaction[]; nodes: TeamNode[]; unavailable: boolean; truncated: boolean;
}) {
  const t = useTeamT();
  const name = (id: string) => {
    const n = nodes.find((n) => n.id === id);
    if (id.startsWith("instance:")) return `${t("外部实例")} · ${id.slice(9)}`;
    return n ? `${n.name}${n.peer ? `@${n.peer}` : ""}` : id.replace(/^(unknown:|local:|instance:|peer:)/, "");
  };
  return <div className={s.activity} aria-label={t("最近往来")}>
    <h3>{t("最近往来")}</h3>
    {!events.length && <p>{t(unavailable ? "数据源不可用" : "最近 10 分钟没有可确认的往来")}</p>}
    {events.slice(0, 40).map((e) => <div key={e.id} className={s.record}>
      <time>{time(e.at)}</time><span>{name(e.from)}{e.to ? ` → ${name(e.to)}` : ` · ${t("收件人未知")}`}</span>
      <b>{t(KIND[e.kind])}{e.task ? ` · ${e.task}` : ""}</b>
    </div>)}
    {(truncated || events.length > 40) && <p>{t("仅显示最新记录，未列全")}</p>}
  </div>;
}
