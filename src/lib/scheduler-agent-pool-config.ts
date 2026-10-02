/** Explicit project pools replace role/tier limits; omission preserves the existing project's policy. */
import type { AuthorFamily } from "./ledger-scheduler.js";
export type AgentLimits = Record<AuthorFamily, number>;
export interface AgentPoolPolicy { agents?: AgentLimits }

export function parseAgents(raw: unknown): AgentPoolPolicy {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("agents must be {claude:N,codex:M}");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== "claude" && k !== "codex") ||
    [r.claude, r.codex].some((n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 32)) {
    throw new Error("agents.claude / agents.codex must be integers 0..32");
  }
  return { agents: { claude: r.claude as number, codex: r.codex as number } };
}

export function agentsFlag(raw: string | undefined): AgentPoolPolicy {
  if (raw === undefined) return {};
  const pairs = raw.split(",").map((part) => part.split("="));
  if (pairs.length !== 2 || new Set(pairs.map(([k]) => k)).size !== 2 ||
    pairs.some(([k, n, extra]) => !["claude", "codex"].includes(k!) || !/^\d{1,2}$/.test(n ?? "") || extra !== undefined)) {
    throw new Error("--agents expects claude=N,codex=M (0..32)");
  }
  return parseAgents(Object.fromEntries(pairs.map(([k, n]) => [k, Number(n)])));
}

/** The existing scheduler-config writer owns locking, full validation and audit rollback. */
export function agentsPatch(p: Record<string, unknown>, set: AgentPoolPolicy): AgentPoolPolicy {
  if (!set.agents) return {};
  parseAgents(set.agents);
  const from = parseAgents(p.agents);
  p.agents = { ...set.agents };
  return { agents: from.agents };
}

export const agentLimitSum = (limits: AgentLimits): number => limits.claude + limits.codex;

/** Retired fields remain in raw JSON for rollback; explicit pools parse only the still-operative remote settings. */
export function agentPoolRemote(raw: unknown, explicit: boolean): unknown {
  if (!explicit || raw === undefined || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  return { mode: r.mode, poolTimeoutMin: r.poolTimeoutMin, ...(r.repo !== undefined ? { repo: r.repo, roles: ["review", "write"] } : { roles: [] }) };
}
