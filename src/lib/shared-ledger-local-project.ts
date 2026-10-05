import { basename, join } from "node:path";
import type { SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { STATE_DIR } from "./paths.js";
import { readProjects, PROJECT_ID_RE } from "./projects.js";
import { readRegistryAgents, REGISTRY_PATH } from "./registry.js";
import { sessionJsonlPath, findSessionJsonlBySessionId } from "./session-source.js";
import { sessionTailInfo } from "./session-tail.js";

export interface SharedLedgerLocalProject { id: string; name: string; lastActivityAt: number }

/** Match only explicit project ids. Unknown shared projects require an owner choice, never a repository guess. */
function sharedLedgerProjectCandidates(projects: SharedLedgerLocalProject[], sharedProjectId?: string): SharedLedgerLocalProject[] {
  const valid = projects.filter(p => PROJECT_ID_RE.test(p.id));
  const same = valid.find(p => p.id === sharedProjectId);
  const recent = [...valid].filter(p => p.id !== same?.id).sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
  return [...(same ? [same] : []), ...recent].slice(0, 3);
}

/** Use actual conversation timestamps, not filesystem mtimes, which background maintenance can bump. */
export async function readSharedLedgerLocalProjects(dir = STATE_DIR): Promise<SharedLedgerLocalProject[]> {
  const [{ projects }, agents] = await Promise.all([readProjects(join(dir, "projects.json")), readRegistryAgents(join(dir, basename(REGISTRY_PATH)))]);
  const activity = new Map<string, number>();
  await Promise.all(agents.map(async a => {
    if (!a.projectId || !a.sessionId || !a.cwd) return;
    const path = sessionJsonlPath(a.runtime, a.cwd, a.sessionId)
      ?? (a.runtime === "codex" ? findSessionJsonlBySessionId(a.runtime, a.sessionId) : null);
    const ts = path ? (await sessionTailInfo(path))?.convTs : null;
    if (ts) activity.set(a.projectId, Math.max(activity.get(a.projectId) ?? 0, ts));
  }));
  return projects.map(p => ({ id: p.id, name: p.name, lastActivityAt: activity.get(p.id) ?? 0 }));
}

export interface SharedLedgerProjectChoice { button: string; localProjectId: string; name: string }
export function sharedLedgerProjectChoices(projects: SharedLedgerLocalProject[], sharedProjectId: string | undefined,
  prefix: string, sameButton?: string): SharedLedgerProjectChoice[] {
  return sharedLedgerProjectCandidates(projects, sharedProjectId).map((p, i) => ({
    button: p.id === sharedProjectId && sameButton ? sameButton : `${prefix}_${i}`, localProjectId: p.id, name: p.name,
  }));
}

export interface SharedLedgerOfferProject { projectId: string; teamId?: string }

/**
 * The binding that supplies the card's shared-project hint. With an explicit project only a center/team/project match counts:
 * another project bound at the same center is never shown as "同名", and an explicit project without its team stays unknown rather
 * than borrowing a binding's team. Old offers carry no project id, so only one existing mapping at this center supplies a hint;
 * ambiguous centers stay unknown.
 */
export function sharedLedgerOfferBinding(centerId: string, bindings: SharedLedgerBinding[],
  explicit?: SharedLedgerOfferProject): SharedLedgerBinding | undefined {
  if (explicit && explicit.teamId === undefined) return undefined;
  const matches = bindings.filter(b => b.centerId === centerId && (!explicit
    || (b.projectId === explicit.projectId && b.teamId === explicit.teamId)));
  return matches.length === 1 ? matches[0] : undefined;
}
export function sharedLedgerOfferProjectId(centerId: string, bindings: SharedLedgerBinding[], explicit?: SharedLedgerOfferProject): string | undefined {
  return sharedLedgerOfferBinding(centerId, bindings, explicit)?.projectId;
}

/** Filter before the three-choice cap so a known pin conflict cannot displace a usable local project. */
export function sharedLedgerEligibleProjects(projects: SharedLedgerLocalProject[], bindings: SharedLedgerBinding[],
  target?: { centerId: string; projectId: string; teamId?: string }): SharedLedgerLocalProject[] {
  return projects.filter(p => !bindings.some(b => (b.localProjectId ?? b.projectId) === p.id
    && (!target || b.centerId !== target.centerId || b.projectId !== target.projectId
      || (target.teamId !== undefined && b.teamId !== target.teamId))));
}
