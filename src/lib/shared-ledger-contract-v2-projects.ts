/** Public PRJ1 wire contract only. Parsers validate JSON, never authenticate a caller or infer authority from grants.
 * Consumers verify signed person/instance identity and current membership before acting. Secrets returned by create,
 * invite and creatorCredential belong only in bridge memory; operation queries and errors contain no credentials.
 */
import {
  array, choice, digest, distinct, fail, id, literal, nullable, object, optional, positive, record,
  refine, text, timestamp, union, V2_ERROR_STATUS, type Infer,
} from "./shared-ledger-contract-v2-validation.js";
import { parseSharedLedgerJoinCode } from "./shared-ledger-join-protocol.js";
import type { V2ProjectsEndpoint, V2ProjectsRequests, V2ProjectsResponses, V2ProjectsExpectedScope } from "./shared-ledger-contract-v2-projects-types.js";
export type * from "./shared-ledger-contract-v2-projects-types.js";

const projectId = refine(text(32, 1), s => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s));
const name = refine(text(64, 1), s => s.trim().length > 0);
const teamFields = { centerId: id, teamId: id };
const identityFields = { ...teamFields, projectId };
const projectStatus = choice(["active", "archived"]);
const role = choice(["owner", "member"]);
const memberStatus = choice(["invited", "active", "removed"]);
export const parseV2ProjectIdentity = object(identityFields);
export const parseV2ProjectRecord = refine(object({
  ...identityFields, code: id, name, createdBy: nullable(id), createdAt: timestamp, updatedAt: timestamp,
  status: projectStatus, rev: positive,
}), p => p.updatedAt >= p.createdAt);
export const parseV2ProjectMember = object({
  ...identityFields, personId: id, code: id, role, status: memberStatus, addedBy: nullable(id), addedAt: timestamp,
});
export const parseV2ProjectTeamMember = object({
  ...teamFields, personId: id, code: id, teamRole: role, status: choice(["active", "removed"]), rev: positive,
});
/** This is an unverified identity declaration, deliberately without a verified flag or role/grant fields. */
export const parseV2ProjectCaller = union(
  object({ kind: literal("person"), personId: id, instanceId: id }),
  object({ kind: literal("service"), serviceId: id, instanceId: id }),
);
export const parseV2ProjectOperation = refine(object({
  ...identityFields, operationId: id, personId: id, instanceId: id, paramsDigest: digest,
  state: choice(["code_issued", "credential_issued", "revoked"]), rev: positive, createdAt: timestamp, updatedAt: timestamp,
}), o => o.updatedAt >= o.createdAt);
/** Existing JN1 encoding; an invite binds one project/person and may bind the creator's original instance. */
export const parseV2ProjectInvite = refine(object({
  ...identityFields, codeId: id, personId: id, instanceId: nullable(id), code: text(160, 1), expiresAt: timestamp,
}), i => {
  const code = parseSharedLedgerJoinCode(i.code);
  return code !== null && code.centerId === i.centerId && code.codeId === i.codeId
    && i.code === `sljoin1.${code.centerId}.${code.codeId}.${code.secret}`;
});

/** Route ids are carried explicitly by adapters; auth stays in signed transport, outside these bodies.
 * No bootstrap endpoint exists: first-owner confirmation remains on the deployment owner's controlled channel.
 */
export const V2_PROJECTS_REQUEST_SCHEMAS = {
  list: object(teamFields),
  create: object({ ...teamFields, operationId: id, id: optional(projectId), name }),
  update: refine(object({ ...identityFields, rev: positive, name: optional(name), status: optional(projectStatus) }),
    r => r.name !== undefined || r.status !== undefined),
  members: parseV2ProjectIdentity,
  invite: union(object({ ...identityFields, personId: id }), object({ ...identityFields, code: id })),
  removeMember: object({ ...identityFields, personId: id }),
  teamOwners: object({ ...teamFields, personId: id, op: choice(["add", "remove"]) }),
  operation: object({ ...teamFields, operationId: id }),
  creatorCredential: object({ ...identityFields, operationId: id, rev: positive }),
} as const;
export function parseV2ProjectsRequest<E extends V2ProjectsEndpoint>(endpoint: E, value: unknown): V2ProjectsRequests[E] {
  if (!Object.hasOwn(V2_PROJECTS_REQUEST_SCHEMAS, endpoint)) return fail();
  return V2_PROJECTS_REQUEST_SCHEMAS[endpoint](value) as V2ProjectsRequests[E];
}

const success = { ok: literal(true), v: literal(2) };
const project = { project: parseV2ProjectRecord };
const operation = { ...project, operation: parseV2ProjectOperation };
const creator = { ...operation, creatorInvite: parseV2ProjectInvite };
const createResult = { ...operation, creatorInvite: nullable(parseV2ProjectInvite) };
function sameIdentity(a: Infer<typeof parseV2ProjectIdentity>, b: Infer<typeof parseV2ProjectIdentity>): boolean {
  return a.centerId === b.centerId && a.teamId === b.teamId && a.projectId === b.projectId;
}
const operationMatches = (r: Infer<ReturnType<typeof object<typeof operation>>>) => sameIdentity(r.project, r.operation)
  && r.project.createdBy === r.operation.personId && r.operation.createdAt >= r.project.createdAt;
const creatorMatches = (r: Infer<ReturnType<typeof object<typeof creator>>>) => operationMatches(r)
  && sameIdentity(r.project, r.creatorInvite) && r.operation.personId === r.creatorInvite.personId
  && r.operation.instanceId === r.creatorInvite.instanceId && r.operation.state === "code_issued"
  && r.creatorInvite.expiresAt > r.operation.updatedAt;
export const V2_PROJECTS_SUCCESS_SCHEMAS = {
  list: refine(object({ ...success, ...teamFields, projects: array(parseV2ProjectRecord) }), r =>
    distinct(r.projects, p => p.projectId) && r.projects.every(p => p.centerId === r.centerId && p.teamId === r.teamId)),
  create: refine(object({ ...success, ...createResult }), r => r.creatorInvite === null
    ? operationMatches(r) && r.operation.state !== "code_issued" : creatorMatches({ ...r, creatorInvite: r.creatorInvite })),
  update: object({ ...success, ...project }),
  members: refine(object({ ...success, ...identityFields, members: array(parseV2ProjectMember) }), r =>
    distinct(r.members, m => m.personId) && r.members.every(m => sameIdentity(r, m))),
  invite: refine(object({ ...success, member: parseV2ProjectMember, invite: parseV2ProjectInvite }), r =>
    sameIdentity(r.member, r.invite) && r.member.personId === r.invite.personId && r.member.status === "invited"),
  removeMember: refine(object({ ...success, member: parseV2ProjectMember }), r => r.member.status === "removed"),
  teamOwners: object({ ...success, member: parseV2ProjectTeamMember }),
  operation: refine(object({ ...success, ...operation }), operationMatches),
  creatorCredential: refine(object({ ...success, ...creator }), creatorMatches),
} as const;
export const V2_PROJECTS_SUCCESS_STATUS = {
  list: 200, create: 201, update: 200, members: 200, invite: 201, removeMember: 200,
  teamOwners: 200, operation: 200, creatorCredential: 200,
} as const;
const error = { ok: literal(false), v: literal(2) };
const simpleErrorCodes = ["invalid_field", "unauthenticated", "bad_signature", "forbidden", "not_found", "unavailable"] as const;
const simpleError = union(...simpleErrorCodes.map(code => object({ ...error, error: literal(code), message: literal(code) })));
const projectConflict = object({ ...error, error: literal("conflict"), message: literal("conflict"), current: parseV2ProjectRecord });
const operationConflict = union(
  object({ ...error, error: literal("conflict"), message: literal("conflict"), current: parseV2ProjectOperation }),
  object({ ...error, error: literal("dedup_mismatch"), message: literal("dedup_mismatch"), current: parseV2ProjectOperation }),
);
export type V2ProjectsSimpleError = Infer<typeof simpleError>;
export type V2ProjectsProjectConflict = Infer<typeof projectConflict>;
export type V2ProjectsOperationConflict = Infer<typeof operationConflict>;

const expectedScope = object({
  ...teamFields, projectId: optional(projectId), operationId: optional(id), personId: optional(id), instanceId: optional(id),
});
function assertExpected(expected: V2ProjectsExpectedScope, value: Record<string, unknown>): void {
  if (value.centerId !== expected.centerId || value.teamId !== expected.teamId
    || (expected.projectId !== undefined && value.projectId !== expected.projectId)) fail();
}
function assertOperation(expected: V2ProjectsExpectedScope, value: Infer<typeof parseV2ProjectOperation>): void {
  assertExpected(expected, value);
  if (value.operationId !== expected.operationId || value.personId !== expected.personId || value.instanceId !== expected.instanceId) fail();
}
/** HTTP status is checked along with the envelope; 409 never accepts untyped/free-text current values.
 * An operation query needs team scope when the new project id is not known after a lost create response.
 */
export function parseV2ProjectsResponse<E extends V2ProjectsEndpoint>(
  endpoint: E, status: number, value: unknown, expected: V2ProjectsExpectedScope,
): V2ProjectsResponses[E] {
  if (!Object.hasOwn(V2_PROJECTS_SUCCESS_SCHEMAS, endpoint)) return fail();
  const identity = expectedScope(expected), raw = record(value);
  if (["update", "members", "invite", "removeMember", "creatorCredential"].includes(endpoint) && identity.projectId === undefined) fail();
  if (["create", "operation", "creatorCredential"].includes(endpoint)
    && (identity.operationId === undefined || identity.personId === undefined || identity.instanceId === undefined)) fail();
  if (["removeMember", "teamOwners"].includes(endpoint) && identity.personId === undefined) fail();
  if (["list", "teamOwners"].includes(endpoint) && identity.projectId !== undefined) fail();
  if (raw.ok === true) {
    if (status !== V2_PROJECTS_SUCCESS_STATUS[endpoint]) return fail();
    const parsed = V2_PROJECTS_SUCCESS_SCHEMAS[endpoint](value);
    if ("operation" in parsed) assertOperation(identity, parsed.operation as Infer<typeof parseV2ProjectOperation>);
    if ("project" in parsed) assertExpected(identity, parsed.project);
    else if ("member" in parsed) {
      assertExpected(identity, parsed.member);
      if (identity.personId !== undefined && parsed.member.personId !== identity.personId) fail();
    }
    else {
      assertExpected(endpoint === "list" ? { centerId: identity.centerId, teamId: identity.teamId } : identity, parsed);
      if (endpoint === "list" && identity.projectId !== undefined) fail();
    }
    return parsed as V2ProjectsResponses[E];
  }
  let parsed: V2ProjectsSimpleError | V2ProjectsProjectConflict | V2ProjectsOperationConflict;
  if (status === 409) {
    if (endpoint === "update") parsed = projectConflict(value);
    else if (endpoint === "create" || endpoint === "creatorCredential") {
      parsed = operationConflict(value);
      if (endpoint === "creatorCredential" && parsed.error !== "conflict") fail();
    } else return fail();
    assertExpected(identity, parsed.current);
    if ("operationId" in parsed.current) assertOperation(identity, parsed.current);
  } else {
    parsed = simpleError(value);
    if (V2_ERROR_STATUS[parsed.error] !== status) fail();
  }
  return parsed as V2ProjectsResponses[E];
}

export const parseV2ProjectDisplay = object({ teamId: id, projectId, name });
const grantProject = refine(object({ projectId, actions: array(choice(["read", "plan", "import", "project"]), 4) }),
  p => p.actions.length > 0 && distinct(p.actions));
const joinGrant = refine(object({
  ...teamFields, personId: id, instanceId: id, bearer: refine(text(43, 43), s => /^[A-Za-z0-9_-]{43}$/.test(s)),
  expiresAt: timestamp, role: choice(["member", "service"]), projects: array(grantProject, 1), project: parseV2ProjectDisplay,
}), g => g.projects.length === 1 && g.project.teamId === g.teamId && g.project.projectId === g.projects[0]!.projectId);
/** New expectedProject enrollment only. Missing display metadata has a fixed unsupported outcome.
 * The role describes the credential class; it supplies neither teamRole nor project membership ownership.
 */
export function parseV2ProjectJoinGrant(value: unknown, expected: V2ProjectsExpectedScope) {
  const identity = expectedScope(expected), raw = record(value);
  if (identity.projectId === undefined || identity.personId === undefined || identity.instanceId === undefined) fail();
  if (!Object.hasOwn(raw, "project")) return fail("unavailable");
  const parsed = joinGrant(value);
  assertExpected(identity, { ...parsed, projectId: parsed.project.projectId });
  if (parsed.personId !== identity.personId || parsed.instanceId !== identity.instanceId) fail();
  return parsed;
}
