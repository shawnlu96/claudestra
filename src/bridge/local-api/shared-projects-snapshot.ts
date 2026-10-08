import { SHARED_PROJECTS_CAPABILITIES } from "./shared-projects-client.js";
import { readProjects } from "../../lib/projects.js";
import { readPeers } from "../../lib/peers.js";
import { isPersonalProject } from "../../lib/lend-policy.js";
import { joinOfferProjectDisplay } from "../../lib/shared-ledger-join-offer.js";
import { looksLikeSharedLedgerJoinCode } from "../../lib/shared-ledger-join.js";
import { parseV2ProjectsResponse, parseV2ProjectsTeamResponse } from "../../lib/shared-ledger-contract-v2-projects.js";
import { requireProjectPerson, SharedProjectsError, type ProjectPerson, type SharedProjectsPorts } from "./shared-projects-ports.js";

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
      invitable: !p.disabled && !!p.baseUrl && !!p.outToken && (!!p.e2e || p.baseUrl.startsWith("https://")) })),
  };
}

type Unavailable = { available: false; reason: string };
/** Fixed reasons only: an old center (404), refusal (403), transport/5xx and malformed bodies never echo center text. */
function teamReadReason(error: unknown): string {
  if (error instanceof SharedProjectsError && error.status === 404) return "center_team_read_not_found";
  if (error instanceof SharedProjectsError && error.status === 403) return "center_team_read_forbidden";
  return "center_team_read_unavailable";
}
/** N9B: team name, active directory and teamRole come only from the center's team read; teamRole only from its `self` row
 * for this signed person. Grants, bindings, request bodies and queries are never consulted. */
async function teamSnapshot(d: SharedProjectsPorts, who: ProjectPerson) {
  const unavailable = (reason: string) => ({ team: { available: false, reason } as Unavailable,
    teamDirectory: { available: false, reason } as Unavailable, teamRole: { available: false, reason } as Unavailable });
  // An adapter without the team read keeps the pre-N9B teamRole value.
  if (!d.team) return unavailable("center_team_role_read_contract_unavailable");
  let raw: unknown;
  try { raw = await d.team(who); }
  catch (error) { return unavailable(teamReadReason(error)); }
  let read;
  try { read = parseV2ProjectsTeamResponse("team", 200, raw, { centerId: who.centerId, teamId: who.teamId, personId: who.personId }); }
  catch { return unavailable("center_team_read_invalid"); } // Parser text may quote the center body.
  if (!read.ok) return unavailable("center_team_read_invalid");
  const { name, code, rev } = read.team;
  // Same display filter as project names: control characters or a join-code look-alike never reach the page.
  if (name !== null && !joinOfferProjectDisplay({ teamId: read.team.teamId, projectId: "team", name })) return unavailable("center_team_read_invalid");
  // Contract ids allow a full sljoin1 code; a join credential in any shown id degrades rather than reaching the page.
  if ([code, read.self.personId, ...read.members.flatMap(m => [m.personId, m.code])].some(looksLikeSharedLedgerJoinCode)) {
    return unavailable("center_team_read_invalid");
  }
  return {
    team: { available: true as const, value: { name, code, rev } },
    teamDirectory: { available: true as const, members: read.members.map(m => ({ personId: m.personId, code: m.code, teamRole: m.teamRole })) },
    teamRole: read.self.personId === who.personId
      ? { available: true as const, value: read.self.teamRole } : { available: false, reason: "center_team_self_mismatch" } as Unavailable,
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
  const { team: teamRecord, teamDirectory, teamRole } = await teamSnapshot(d, who);
  return {
    v: 1 as const, identity: { ...who }, capabilities: SHARED_PROJECTS_CAPABILITIES,
    teamRole, team: teamRecord, teamDirectory, projects,
    localProjects: local.projects.map(p => ({ id: p.id, name: p.name, dirs: [...p.dirs], personal: p.personal,
      eligible: !p.personal && !bindings.some(b => (b.localProjectId ?? b.projectId) === p.id) })),
    peers: local.peers.map(p => ({ name: p.name, enabled: p.enabled, invitable: p.invitable })),
  };
}
export type SharedProjectsSnapshot = Awaited<ReturnType<typeof sharedProjectsSnapshot>>;
