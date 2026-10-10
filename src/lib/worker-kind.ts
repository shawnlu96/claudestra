/** One worker classification rule for create, registry rewrites and the idempotent legacy migration. */
import { bareCanonicalName, isMasterName } from "./registry.js";

export type AgentKind = "worker" | "main";
export interface KindEvidence { kind?: AgentKind; task?: string; parent?: string; role?: string }

const protectedName = (name: string, role?: string, pms: readonly string[] = []): boolean =>
  isMasterName(name) || bareCanonicalName(name) === "codex" || role === "pm" || pms.some((pm) => bareCanonicalName(pm) === bareCanonicalName(name));

/** Only explicit registry tags classify workers; names, task text and scheduler roles are not bindings. */
export function workerKind(name: string, info: KindEvidence, pms: readonly string[] | null = []): AgentKind | null {
  if (info.kind === "main") return "main";
  if (pms === null) return null; // An unreadable PM list cannot establish that a tagged agent is safe to hide.
  if (protectedName(name, info.role, pms)) return null;
  if (info.kind === "worker") return "worker";
  return null;
}

/** The single explicit tagging entry used by owner override and scheduler session binding. */
export function setWorkerKind(agents: Record<string, KindEvidence>, name: string, kind: AgentKind, pms: readonly string[] = []): boolean {
  const info = agents[name];
  if (!info || (kind === "worker" && protectedName(name, info.role, pms))) return false;
  if (info.kind === "main" && kind === "worker") return true;
  info.kind = kind;
  return true;
}

/** Mutates only the kind field; callers keep their existing registry lock and atomic writer. */
export function markWorkerKinds(agents: Record<string, KindEvidence>, pms: readonly string[] = []): number {
  let changed = 0;
  for (const [name, info] of Object.entries(agents)) {
    const want = workerKind(name, info, pms);
    if (want === info.kind || (want === null && info.kind === undefined)) continue;
    if (want) info.kind = want;
    else delete info.kind;
    changed++;
  }
  return changed;
}

/** Global history excludes tagged workers, including archived tags; an explicit agent query still works. */
export function visibleInDefaultSearch(name: string, info?: KindEvidence, archivedWorker = false): boolean {
  if (info?.kind === "main") return true;
  return workerKind(name, info ?? {}) !== "worker" && !archivedWorker;
}
