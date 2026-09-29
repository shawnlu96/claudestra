/** Pure team projection. Missing data is unknown, never an idle or available claim. */
export interface TeamAgent {
  name: string;
  projectId?: string | null;
  runtime?: string | null;
  model?: string | null;
  status?: string;
  busy?: boolean;
  contextTokens?: number | null;
  archived?: boolean;
}
export interface TeamPeer {
  name: string;
  online: boolean | null;
  stale: boolean;
  checkedAt?: string;
  agents: { name: string; busy?: boolean; stopped?: boolean }[];
}
export type TeamQuota = { provider: string; used: number | null; observedAt: number | null };
export type WorkState = "busy" | "idle" | "stopped" | "unknown";

export function workState(a: { status?: string; busy?: boolean; stopped?: boolean }): WorkState {
  if (a.stopped || a.status === "stopped") return "stopped";
  if (a.status && a.status !== "active") return "unknown";
  return a.busy === true ? "busy" : a.busy === false ? "idle" : "unknown";
}

export function peerWorkState(peer: TeamPeer, a: TeamPeer["agents"][number], now: number): WorkState {
  const at = Date.parse(peer.checkedAt ?? "");
  if (peer.online !== true || peer.stale || !Number.isFinite(at) || now - at > 180_000 || at > now) return "unknown";
  return workState(a);
}

/** Match both instance and exact executor name; similar names and other peers must not share cards. */
export function executorMatches(value: unknown, peer: string, agent: string): boolean {
  if (typeof value !== "string") return false;
  const at = value.lastIndexOf("@");
  return at > 0 && value.slice(at + 1) === peer && value.slice(0, at).replace(/^agent-/, "") === agent.replace(/^agent-/, "");
}

export function contextText(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? `${Math.round(value).toLocaleString()} tokens` : null;
}

export function quotaTier(q: TeamQuota, now: number): "available" | "busy" | "closed" | "unknown" {
  if (q.used === null || !Number.isFinite(q.used) || q.observedAt === null || now < q.observedAt || now - q.observedAt > 300_000) return "unknown";
  return q.used >= 100 ? "closed" : q.used >= 90 ? "busy" : "available";
}
