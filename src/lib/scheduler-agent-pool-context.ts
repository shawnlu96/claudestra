/** Reads live project policy at transaction boundaries; daemon flags cannot restore retired role limits. */
import type { Database } from "bun:sqlite";
import type { RemotePolicy } from "./scheduler-config.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import type { BorrowEntry } from "./lend-config.js";
import { localAgentPool } from "./scheduler-agent-pool-ledger.js";
import type { PlacementFacts } from "./scheduler-placement.js";

export function projectAgentPolicy(project: string): RemotePolicy | null {
  const policy = readSchedulerConfig().projects[project];
  return policy?.agents ? policy.remote ?? null : null;
}

export function unifiedBorrow(project: string, entry: BorrowEntry | null): BorrowEntry | null {
  return poolBorrow(entry, !!projectAgentPolicy(project));
}

export function poolLocalFacts(db: Database, project: string, remote: RemotePolicy | null, exceptTask: string | null = null): PlacementFacts["local"] | null {
  if (!remote?.agents) return null;
  const pool = localAgentPool(db, project, remote.agents, exceptTask);
  return { pool, running: pool.running.claude + pool.running.codex, room: Object.keys(pool.totals)
    .some((f) => pool.running[f as "claude" | "codex"] < pool.totals[f as "claude" | "codex"]) };
}

/** CLI test injection and production project policy share the same boundary; legacy flag-only invocations stay valid. */
export function poolRemotePolicy(project: string, fallback: RemotePolicy,
  injected?: { remote?: RemotePolicy; maxActiveWorkers: number } | null): RemotePolicy {
  return injected?.remote?.agents ? injected.remote : projectAgentPolicy(project) ?? fallback;
}

export function poolBorrow(entry: BorrowEntry | null, unified: boolean): BorrowEntry | null {
  return entry && unified ? { ...entry, roles: ["review", "write"], maxOpen: Number.MAX_SAFE_INTEGER } : entry;
}
