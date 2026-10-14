import { looksLikeSharedLedgerJoinCode } from "../../lib/shared-ledger-join.js";
import { parseV2ProjectsTeamResponse } from "../../lib/shared-ledger-contract-v2-projects.js";
import type { ProjectPerson, SharedProjectsPorts } from "./shared-projects-ports.js";

type Unavailable = { available: false; reason: string };
export type TeamInstancesSnapshot = { available: true; instances: { personId: string; instanceId: string }[] } | Unavailable;
type DirectorySnapshot = { available: true; members: { personId: string }[] } | Unavailable;

/** ROSTER2a: instance → person comes only from the center's GET /v1/team/instances, never from peer names or peers.json.
 * The read starts at once so it runs alongside the team read; the result keeps only people in this snapshot's directory.
 * Reasons are fixed strings and never echo center text. Nothing here can change team / teamDirectory / teamRole.
 */
export async function teamInstancesSnapshot(d: SharedProjectsPorts, who: ProjectPerson,
  directory: Promise<DirectorySnapshot>): Promise<TeamInstancesSnapshot> {
  const unavailable = (reason: string): Unavailable => ({ available: false, reason });
  // An adapter without the instances read sends no request.
  if (!d.teamInstances) return unavailable("center_team_instances_contract_unavailable");
  const read = d.teamInstances(who).then(raw => ({ ok: true as const, raw }), () => ({ ok: false as const }));
  const [members, result] = await Promise.all([directory, read]);
  if (!members.available) return unavailable("center_team_directory_unavailable");
  // Any non-200 (an old center answers 403), transport failure or 5xx.
  if (!result.ok) return unavailable("center_team_instances_unavailable");
  let parsed;
  try { parsed = parseV2ProjectsTeamResponse("teamInstances", 200, result.raw, { centerId: who.centerId, teamId: who.teamId }); }
  catch { return unavailable("center_team_instances_invalid"); } // Parser text may quote the center body.
  if (!parsed.ok) return unavailable("center_team_instances_invalid");
  // Contract ids allow a full sljoin1 code; a join credential in any id degrades rather than reaching the page.
  if (parsed.instances.some(i => looksLikeSharedLedgerJoinCode(i.personId) || looksLikeSharedLedgerJoinCode(i.instanceId))) {
    return unavailable("center_team_instances_invalid");
  }
  const people = new Set(members.members.map(m => m.personId));
  return { available: true, instances: parsed.instances.filter(i => people.has(i.personId))
    .map(i => ({ personId: i.personId, instanceId: i.instanceId })) };
}
