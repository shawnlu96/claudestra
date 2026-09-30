/** One worker classification rule for create, registry rewrites and the idempotent legacy migration. */
import { bareCanonicalName, isMasterName } from "./registry.js";

export type AgentKind = "worker" | "main";
export interface KindEvidence { kind?: AgentKind; task?: string; parent?: string; role?: string }

const protectedName = (name: string, role?: string): boolean => isMasterName(name) || bareCanonicalName(name) === "codex" || role === "pm";

/** Task labels are ambiguous; only an explicit kind, scheduler role or task-worker name hides a session. */
export function workerKind(name: string, info: KindEvidence): AgentKind | null {
  if (info.kind === "main") return "main";
  if (protectedName(name, info.role)) return null;
  if (info.kind === "worker" || info.role === "dispatcher" || info.role === "executor" || /^agent-task-/i.test(name)) return "worker";
  return null;
}

/** The single explicit tagging entry used by owner override and scheduler session binding. */
export function setWorkerKind(agents: Record<string, KindEvidence>, name: string, kind: AgentKind): boolean {
  const info = agents[name];
  if (!info || (kind === "worker" && protectedName(name, info.role))) return false;
  if (info.kind === "main" && kind === "worker") return true;
  info.kind = kind;
  return true;
}

/** Mutates only the kind field; callers keep their existing registry lock and atomic writer. */
export function markWorkerKinds(agents: Record<string, KindEvidence>): number {
  let changed = 0;
  for (const [name, info] of Object.entries(agents)) {
    const want = workerKind(name, info);
    if (want === info.kind || (want === null && info.kind === undefined)) continue;
    if (want) info.kind = want;
    else delete info.kind;
    changed++;
  }
  return changed;
}

/** Global history excludes current tagged workers and removed legacy task workers; an explicit agent query still works. */
export function visibleInDefaultSearch(name: string, info?: KindEvidence, archivedWorker = false): boolean {
  if (info?.kind === "main") return true;
  return info?.kind !== "worker" && !archivedWorker && !/^agent-task-/i.test(name);
}
