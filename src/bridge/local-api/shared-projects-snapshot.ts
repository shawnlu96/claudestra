import { SHARED_PROJECTS_CAPABILITIES } from "./shared-projects-client.js";
import { readProjects } from "../../lib/projects.js";
import { readPeers } from "../../lib/peers.js";
import { isPersonalProject } from "../../lib/lend-policy.js";
import { parseV2ProjectsResponse } from "../../lib/shared-ledger-contract-v2-projects.js";
import { requireProjectPerson, SharedProjectsError, type SharedProjectsPorts } from "./shared-projects-ports.js";

export interface SharedProjectsLocalSnapshot {
  projects: { id: string; name: string; dirs: string[]; personal: boolean }[];
  peers: { name: string; enabled: boolean; invitable: boolean }[];
}
/** Local configuration is the source; directory contents, git metadata and inferred person mappings are never consulted. */
export async function readSharedProjectsLocalSnapshot(): Promise<SharedProjectsLocalSnapshot> {
  const [local, peerState] = await Promise.all([readProjects(), readPeers()]);
  return {
    projects: local.projects.map(p => ({ id: p.id, name: p.name, dirs: [...p.dirs], personal: isPersonalProject(p) })),
    peers: (peerState.httpPeers ?? []).map(p => ({ name: p.name, enabled: !p.disabled,
      invitable: false })),
  };
}

/** N5 reads this N4 producer. Unavailable roles are explicit; membership comes only from canonical center records. */
export async function sharedProjectsSnapshot(d: SharedProjectsPorts, local: SharedProjectsLocalSnapshot) {
  const who = await d.person();
  requireProjectPerson(who);
  const team = { centerId: who.centerId, teamId: who.teamId };
  const response = parseV2ProjectsResponse("list", 200, { ok: true, v: 2, ...team, projects: await d.list(who) }, team);
  if (!response.ok) throw new SharedProjectsError(503, "invalid_center_response");
  const bindings = d.bindings();
  const projects = await Promise.all(response.projects.map(async project => {
    let projectRole: { available: false; reason: string } | { available: true; value: "owner" | "member" };
    try {
      const identity = { ...team, projectId: project.projectId };
      const members = parseV2ProjectsResponse("members", 200, { ok: true, v: 2, ...identity,
        members: await d.members(who, project.projectId) }, identity);
      const self = members.ok ? members.members.filter(m => m.personId === who.personId && m.status === "active") : [];
      projectRole = self.length === 1 ? { available: true, value: self[0]!.role } : { available: false, reason: "active_membership_unavailable" };
    } catch {
      // A failed center read cannot authorize project controls; fixed availability data reveals no transport body.
      projectRole = { available: false, reason: "center_members_read_unavailable" };
    }
    return { ...project, projectRole, localProjectIds: bindings.filter(b => b.centerId === project.centerId
      && b.teamId === project.teamId && b.projectId === project.projectId).map(b => b.localProjectId ?? b.projectId) };
  }));
  return {
    v: 1 as const, identity: { ...who }, capabilities: SHARED_PROJECTS_CAPABILITIES,
    teamRole: { available: false as const, reason: "center_team_role_read_contract_unavailable" }, projects,
    localProjects: local.projects.map(p => ({ id: p.id, name: p.name, dirs: [...p.dirs], personal: p.personal,
      eligible: !p.personal && !bindings.some(b => (b.localProjectId ?? b.projectId) === p.id) })),
    peers: local.peers.map(p => ({ name: p.name, enabled: p.enabled, invitable: p.invitable })),
  };
}
export type SharedProjectsSnapshot = Awaited<ReturnType<typeof sharedProjectsSnapshot>>;
