import type { TeamAgent, TeamPeer } from "./team-panel-model";

export interface TeamNode {
  id: string; name: string; role: string; peer?: string; agent?: TeamAgent;
  remote?: TeamPeer["agents"][number]; presence?: TeamPeer;
}
export interface Interaction {
  id: string; at: number; from: string; to: string | null;
  kind: "assign" | "dispatch" | "deliver" | "review" | "message"; task: string | null;
}
export interface ActivitySnapshot { now: number; roles?: { id: string; role: string }[]; interactions: Interaction[]; truncated: boolean }

export const localId = (name: string) => `local:${name.replace(/^agent-/, "")}`;
export const peerId = (peer: string, name: string) => `peer:${peer}/${name.replace(/^agent-/, "")}`;

export function teamNodes(agents: readonly TeamAgent[], peers: readonly TeamPeer[], pms: readonly string[]): TeamNode[] {
  const nodes: TeamNode[] = [{ id: "owner", name: "owner", role: "owner" }];
  const seen = new Set(["owner"]);
  for (const agent of agents) {
    const id = localId(agent.name);
    if (agent.archived || seen.has(id)) continue;
    seen.add(id);
    const name = agent.name.replace(/^agent-/, "");
    const role = name === "master" ? "master" : pms.some((p) => localId(p) === id) ? "PM" : "agent";
    nodes.push({ id, name, role, agent });
  }
  for (const presence of peers) for (const remote of presence.agents) {
    const id = peerId(presence.name, remote.name);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = remote.name.replace(/^agent-/, "");
    const role = pms.some((p) => p === `${remote.name}@${presence.name}` || p === `${name}@${presence.name}`) ? "PM" : "agent";
    nodes.push({ id, name, role, peer: presence.name, presence, remote });
  }
  return nodes;
}

export function visibleInteractions(events: readonly Interaction[], nodes: readonly TeamNode[], now: number): Interaction[] {
  const ids = new Set(nodes.map((n) => n.id));
  return [...new Map(events.filter((e) => e.at > now - 600_000 && e.at <= now && ids.has(e.from) &&
    (!e.to || ids.has(e.to))).map((e) => [e.id, e])).values()].sort((a, b) => b.at - a.at);
}

/** Stable grid slots avoid a live edge moving every time busy state changes. */
export function nodePositions(nodes: readonly TeamNode[]) {
  return new Map(nodes.map((n, i) => [n.id, { x: 24 + (i % 3) * 330, y: 28 + Math.floor(i / 3) * 235 }]));
}
