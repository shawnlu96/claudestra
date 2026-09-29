/** One worker classification rule for create, registry rewrites and the idempotent legacy migration. */
import { bareCanonicalName, isMasterName } from "./registry.js";

export type AgentKind = "worker";
export interface KindEvidence { kind?: AgentKind; task?: string; parent?: string; role?: string }

const protectedName = (name: string, role?: string): boolean => isMasterName(name) || bareCanonicalName(name) === "codex" || role === "pm";

/** Explicit new --task marks even without a parent; old rows require stronger evidence to avoid hiding a main agent. */
export function workerKind(name: string, info: KindEvidence, newlyCreated = false): AgentKind | null {
  if (protectedName(name, info.role)) return null;
  if (info.kind === "worker" || info.role === "dispatcher" || info.role === "executor" || /^agent-task-/i.test(name)) return "worker";
  return info.task?.trim() && (newlyCreated || info.parent) ? "worker" : null;
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
  return info?.kind !== "worker" && !archivedWorker && !/^agent-task-/i.test(name);
}
