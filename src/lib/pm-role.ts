import type { Database } from "bun:sqlite";
import { getMeta } from "./ledger-store.js";
import { bareCanonicalName, agentRuntime, type RegistryAgent } from "./registry.js";

/** No pointer preserves the historical first-non-dispatcher rule. */
export function pmPointer(db: Database, project: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE project = ? AND key = 'activePm'").get(project) as { value: string } | null;
  const value: unknown = row ? JSON.parse(row.value) : null;
  if (value !== null && (typeof value !== "string" || !value)) throw new Error("invalid activePm pointer");
  return value as string | null;
}

export function activeProjectPm(db: Database, project: string): string | null {
  const meta = getMeta(db, project);
  return pmPointer(db, project) ?? meta.pms.find((p) => p !== meta.team?.dispatcher) ?? null;
}

export function pmRedirect(db: Database, project: string, target: string, sender?: string): string | null {
  const pointer = pmPointer(db, project), meta = getMeta(db, project);
  if (!pointer || pointer === target || target === meta.team?.dispatcher || !meta.pms.includes(target)) return null;
  // Retired PMs can finish their own conversations without redirecting their outbound replies.
  if (sender && meta.pms.includes(sender) && sender !== pointer && sender !== meta.team?.dispatcher) return null;
  // A feature's recorded PM (autostart meta features[*].pm, PMWAKE) is addressed by name, not redirected to the on-duty PM.
  const sw = db.query("SELECT value FROM meta WHERE project = ? AND key = 'autostart'").get(project) as { value: string } | null;
  const features = sw ? (JSON.parse(sw.value) as { features?: Record<string, { pm?: string }> }).features : undefined;
  return Object.values(features ?? {}).some((f) => f.pm === target) ? null : pointer;
}

export function isPmCandidate(agent: Pick<RegistryAgent, "name" | "kind">): boolean {
  return agent.kind !== "worker" && !/^(?:task|rv|cx|lend|worker|reviewer|cron)(?:-|$)/i.test(bareCanonicalName(agent.name));
}

export function pmCandidates(db: Database, project: string, agents: RegistryAgent[], online: ReadonlySet<string>) {
  const meta = getMeta(db, project);
  const names = new Set([...meta.pms, ...agents.filter((a) => a.projectId === project && isPmCandidate(a)).map((a) => a.name)]);
  return [...names].filter((name) => name !== meta.team?.dispatcher).map((name) => {
    const agent = agents.find((a) => a.name === name);
    return { name, runtime: agentRuntime(agent), online: online.has(name), registered: !!agent && agent.projectId === project };
  });
}
