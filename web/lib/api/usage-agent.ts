import { api } from "./client";
import { apiAgentName } from "@/lib/chat/agents";

export interface AgentTokenSums {
  input: number; cacheRead: number; cacheCreation: number; output: number; reasoning: number; calls: number; totalTokens: number;
}
export interface AgentUsageSummary {
  since: number;
  total: AgentTokenSums;
  rows: (AgentTokenSums & { runtime: string; model: string; modelBasis: "request" | "response" })[];
}
export interface AgentUsageTurn {
  id: string; startedAt: number; runtime: string; kind: string; trigger: string;
  calls: number; contextSeen: number; totalTokens: number; output: number; reasoning: number;
  tools: { name: string; count: number }[];
  attr: { task: string | null; step: string | null; round: number | null; basis: string | null };
}
export interface AgentUsage {
  agent: string;
  state: "ready" | "empty" | "missing" | "expired";
  today: AgentUsageSummary | null;
  week: AgentUsageSummary | null;
  turns: AgentUsageTurn[];
  next: string | null;
}
export function fetchAgentUsage(name: string, before?: string, signal?: AbortSignal): Promise<AgentUsage> {
  const params = new URLSearchParams({ limit: "20" });
  if (before) params.set("before", before);
  return api(`/usage/agent/${encodeURIComponent(apiAgentName(name))}?${params}`, { signal });
}
