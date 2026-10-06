import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import type {
  V2ProjectIdentity, V2ProjectRecord, V2ProjectMember, V2ProjectTeamMember, V2ProjectCaller,
  V2ProjectOperation, V2ProjectInvite, V2ProjectDisplay, V2ProjectJoinGrant,
  V2ProjectsExpectedScope, V2ProjectsRequests, V2ProjectsSuccesses, V2ProjectsEndpoint,
} from "./shared-ledger-contract-v2-projects-types.js";

/** Fresh synthetic JSON for public consumers. No state, network, real invitations, keys or bearer issuance.
 * The recognizable repeated fake secret exists only in the returned objects, never in errors or operation queries.
 */
export function createV2ProjectsFixtures() {
  const identity: V2ProjectIdentity = { centerId: `center-${"1".repeat(32)}`, teamId: "team-demo", projectId: "demo-b" };
  const team = { centerId: identity.centerId, teamId: identity.teamId };
  const person: V2ProjectCaller = { kind: "person", personId: "person-demo", instanceId: "instance-demo" };
  const service: V2ProjectCaller = { kind: "service", serviceId: "service-demo", instanceId: "instance-demo" };
  const project: V2ProjectRecord = {
    ...identity, code: "demo-b", name: "合成项目 B", createdBy: person.personId,
    createdAt: 1000, updatedAt: 1000, status: "active", rev: 1,
  };
  const member: V2ProjectMember = {
    ...identity, personId: person.personId, code: "demo-person", role: "owner", status: "active", addedBy: person.personId, addedAt: 1000,
  };
  const teamMember: V2ProjectTeamMember = { ...team, personId: person.personId, code: "demo-person", teamRole: "member", status: "active", rev: 1 };
  const operation: V2ProjectOperation = {
    ...identity, operationId: "operation-demo", personId: person.personId, instanceId: person.instanceId,
    paramsDigest: v2ObjectDigest({ id: identity.projectId, name: project.name }), state: "code_issued", rev: 1, createdAt: 1000, updatedAt: 1000,
  };
  const creatorInvite: V2ProjectInvite = {
    ...identity, codeId: "2".repeat(32), personId: person.personId, instanceId: person.instanceId,
    code: `sljoin1.${identity.centerId}.${"2".repeat(32)}.${"F".repeat(43)}`, expiresAt: 60000,
  };
  const invitedMember: V2ProjectMember = { ...member, personId: "person-peer", code: "demo-peer", role: "member", status: "invited" };
  const invite: V2ProjectInvite = { ...creatorInvite, personId: invitedMember.personId, instanceId: null };
  const display: V2ProjectDisplay = { teamId: identity.teamId, projectId: identity.projectId, name: project.name };
  const grant: V2ProjectJoinGrant = {
    ...team, personId: person.personId, instanceId: person.instanceId, bearer: "F".repeat(43), expiresAt: 60000,
    role: "member", projects: [{ projectId: identity.projectId, actions: ["read", "plan"] }], project: display,
  };
  const operationScope: V2ProjectsExpectedScope = {
    ...identity, operationId: operation.operationId, personId: person.personId, instanceId: person.instanceId,
  };
  const requests: V2ProjectsRequests = {
    list: team, create: { ...team, operationId: operation.operationId, id: identity.projectId, name: project.name },
    update: { ...identity, rev: 1, name: "合成项目 B 改名", status: "archived" }, members: identity,
    invite: { ...identity, personId: invitedMember.personId }, removeMember: { ...identity, personId: invitedMember.personId },
    teamOwners: { ...team, personId: person.personId, op: "add" }, operation: { ...team, operationId: operation.operationId },
    creatorCredential: { ...identity, operationId: operation.operationId, rev: 1 },
  };
  const success = { ok: true, v: 2 } as const;
  const responses: V2ProjectsSuccesses = {
    list: { ...success, ...team, projects: [project] }, create: { ...success, project, operation, creatorInvite },
    update: { ...success, project: { ...project, name: requests.update.name!, status: "archived", rev: 2, updatedAt: 2000 } },
    members: { ...success, ...identity, members: [member, invitedMember] },
    invite: { ...success, member: invitedMember, invite }, removeMember: { ...success, member: { ...invitedMember, status: "removed" } },
    teamOwners: { ...success, member: { ...teamMember, teamRole: "owner", rev: 2 } },
    operation: { ...success, project, operation }, creatorCredential: { ...success, project, operation, creatorInvite },
  };
  const scopes: Record<V2ProjectsEndpoint, V2ProjectsExpectedScope> = {
    list: team, create: { ...operationScope, projectId: undefined }, update: identity, members: identity,
    invite: { ...identity, personId: invitedMember.personId }, removeMember: { ...identity, personId: invitedMember.personId },
    teamOwners: { ...team, personId: person.personId }, operation: { ...operationScope, projectId: undefined }, creatorCredential: operationScope,
  };
  const errors = {
    forbidden: { ok: false, v: 2, error: "forbidden", message: "forbidden" },
    notFound: { ok: false, v: 2, error: "not_found", message: "not_found" },
    projectConflict: { ok: false, v: 2, error: "conflict", message: "conflict", current: responses.update.project },
    operationConflict: { ok: false, v: 2, error: "conflict", message: "conflict", current: { ...operation, rev: 2 } },
    dedupMismatch: { ok: false, v: 2, error: "dedup_mismatch", message: "dedup_mismatch", current: operation },
  } as const;
  const invalidResponses: { label: string; endpoint: V2ProjectsEndpoint; status: number; body: unknown }[] = [
    { label: "wrong list identity", endpoint: "list", status: 200,
      body: { ...responses.list, projects: [{ ...project, teamId: "other-team" }] } },
    { label: "unknown path", endpoint: "update", status: 200, body: { ...responses.update, path: "/not/a/real/path" } },
    { label: "wrong project", endpoint: "update", status: 200, body: { ...responses.update, project: { ...project, projectId: "other" } } },
    { label: "noninteger revision", endpoint: "update", status: 200, body: { ...responses.update, project: { ...project, rev: 1.5 } } },
    { label: "invalid member role", endpoint: "members", status: 200, body: { ...responses.members, members: [{ ...member, role: "service" }] } },
    { label: "invalid operation state", endpoint: "operation", status: 200,
      body: { ...responses.operation, operation: { ...operation, state: "locally_saved" } } },
    { label: "other operation", endpoint: "operation", status: 200,
      body: { ...responses.operation, operation: { ...operation, operationId: "other" } } },
    { label: "other creator instance", endpoint: "creatorCredential", status: 200,
      body: { ...responses.creatorCredential, operation: { ...operation, instanceId: "other" }, creatorInvite: { ...creatorInvite, instanceId: "other" } } },
    { label: "query leaked code", endpoint: "operation", status: 200, body: { ...responses.operation, creatorInvite } },
    { label: "invalid conflict current", endpoint: "update", status: 409, body: { ...errors.projectConflict, current: "untyped" } },
    { label: "secret error text", endpoint: "update", status: 403, body: { ...errors.forbidden, message: creatorInvite.code } },
    { label: "wrong error status", endpoint: "update", status: 404, body: errors.forbidden },
  ];
  return { identity, project, member, teamMember, person, service, operation, creatorInvite, invite, display, grant, operationScope,
    requests, responses, scopes, errors, invalidResponses };
}
