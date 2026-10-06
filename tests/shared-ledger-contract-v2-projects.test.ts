import { describe, expect, test } from "bun:test";
import {
  parseV2ProjectIdentity, parseV2ProjectRecord, parseV2ProjectMember, parseV2ProjectTeamMember, parseV2ProjectCaller,
  parseV2ProjectOperation, parseV2ProjectInvite, parseV2ProjectDisplay, parseV2ProjectJoinGrant,
  parseV2ProjectsRequest, parseV2ProjectsResponse, V2_PROJECTS_REQUEST_SCHEMAS, V2_PROJECTS_SUCCESS_SCHEMAS, V2_PROJECTS_SUCCESS_STATUS,
  type V2ProjectsEndpoint, type V2ProjectsResponses,
} from "../src/lib/shared-ledger-contract-v2-projects.js";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { V2ContractError, type V2ErrorCode } from "../src/lib/shared-ledger-contract-v2-validation.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";

function invalid(fn: () => unknown, code: V2ErrorCode = "invalid_field") {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(V2ContractError);
  expect((caught as V2ContractError).code).toBe(code);
  expect((caught as Error).message).toBe(code);
}
const endpoints = ["list", "create", "update", "members", "invite", "removeMember", "teamOwners", "operation", "creatorCredential"] as const;
describe("public project contract: frozen endpoint names and envelopes", () => {
  test("exact endpoint/export maps", () => {
    expect(Object.keys(V2_PROJECTS_REQUEST_SCHEMAS)).toEqual([...endpoints]);
    expect(Object.keys(V2_PROJECTS_SUCCESS_SCHEMAS)).toEqual([...endpoints]);
    expect(V2_PROJECTS_SUCCESS_STATUS).toEqual({
      list: 200, create: 201, update: 200, members: 200, invite: 201, removeMember: 200, teamOwners: 200, operation: 200, creatorCredential: 200,
    });
  });
  for (const endpoint of endpoints) {
    test(`${endpoint}: public synthetic request/response and status`, () => {
      const f = createV2ProjectsFixtures();
      expect(parseV2ProjectsRequest(endpoint, f.requests[endpoint])).toEqual(f.requests[endpoint]);
      const parsed: V2ProjectsResponses[typeof endpoint] = parseV2ProjectsResponse(endpoint,
        V2_PROJECTS_SUCCESS_STATUS[endpoint], f.responses[endpoint], f.scopes[endpoint]);
      expect(parsed).toEqual(f.responses[endpoint]);
      invalid(() => parseV2ProjectsRequest(endpoint, { ...f.requests[endpoint], caller: f.person }));
      for (const bad of [null, [], "response", { ...f.responses[endpoint], v: 1 }, { ...f.responses[endpoint], localProjectId: "local" }]) {
        invalid(() => parseV2ProjectsResponse(endpoint, V2_PROJECTS_SUCCESS_STATUS[endpoint], bad, f.scopes[endpoint]));
      }
      invalid(() => parseV2ProjectsResponse(endpoint, 202, f.responses[endpoint], f.scopes[endpoint]));
    });
  }
  test("all required DTO fields and non-JSON structures fail closed", () => {
    const f = createV2ProjectsFixtures();
    const rows: [((v: unknown) => unknown), object][] = [
      [parseV2ProjectIdentity, f.identity], [parseV2ProjectRecord, f.project], [parseV2ProjectMember, f.member],
      [parseV2ProjectTeamMember, f.teamMember], [parseV2ProjectCaller, f.person], [parseV2ProjectCaller, f.service],
      [parseV2ProjectOperation, f.operation], [parseV2ProjectInvite, f.invite], [parseV2ProjectDisplay, f.display],
    ];
    for (const [parser, row] of rows) {
      expect(parser(row)).toEqual(row);
      for (const key of Object.keys(row)) {
        const missing: Record<string, unknown> = { ...row }; delete missing[key];
        invalid(() => parser(missing));
      }
      for (const bad of [null, [], false, 1, "x", { ...row, dirs: ["/fake/path"] }, Object.create(row),
        { ...row, [Symbol("hidden")]: "x" }, Object.defineProperty({ ...row }, "hidden", { value: "x" }),
        Object.defineProperty({ ...row }, "hidden", { enumerable: true, get() { throw Error("secret"); } })]) invalid(() => parser(bad));
    }
  });
  test("fixture negative responses cover identity, role, revision, operation state and error body", () => {
    const f = createV2ProjectsFixtures();
    for (const probe of f.invalidResponses) {
      invalid(() => parseV2ProjectsResponse(probe.endpoint, probe.status, probe.body, f.scopes[probe.endpoint]));
    }
  });
});

test("names, ids, legacy rows, revisions and timestamps have one public spelling", () => {
  const f = createV2ProjectsFixtures();
  expect(parseV2ProjectRecord({ ...f.project, createdBy: null, createdAt: 0, updatedAt: 0 }).createdBy).toBeNull();
  expect(parseV2ProjectRecord({ ...f.project, name: "中".repeat(64) }).name).toHaveLength(64);
  for (const name of ["", " ", "\n\t", "中".repeat(65), "secret\0"]) invalid(() => parseV2ProjectRecord({ ...f.project, name }));
  for (const projectId of ["Owner", "a/b", "/tmp/demo", "../demo", "x".repeat(33)]) invalid(() => parseV2ProjectIdentity({ ...f.identity, projectId }));
  for (const rev of [0, -1, 1.5, "1", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => parseV2ProjectRecord({ ...f.project, rev }));
    invalid(() => parseV2ProjectOperation({ ...f.operation, rev }));
    invalid(() => parseV2ProjectsRequest("update", { ...f.requests.update, rev }));
    invalid(() => parseV2ProjectsRequest("creatorCredential", { ...f.requests.creatorCredential, rev }));
  }
  invalid(() => parseV2ProjectRecord({ ...f.project, updatedAt: 999 }));
  invalid(() => parseV2ProjectOperation({ ...f.operation, createdAt: 1.5 }));
  invalid(() => parseV2ProjectOperation({ ...f.operation, updatedAt: 999 }));
});

test("caller declarations and grant actions never supply team/project ownership", () => {
  const f = createV2ProjectsFixtures();
  for (const caller of [f.person, f.service]) {
    const parsed = parseV2ProjectCaller(caller);
    expect(parsed).toEqual(caller);
    for (const key of ["verified", "owner", "teamRole", "role", "grants"]) invalid(() => parseV2ProjectCaller({ ...caller, [key]: true }));
  }
  invalid(() => parseV2ProjectCaller({ ...f.service, personId: "person-demo" }));
  invalid(() => parseV2ProjectCaller({ ...f.person, kind: "service" }));
  for (const role of ["service", "admin", "Owner"]) {
    invalid(() => parseV2ProjectMember({ ...f.member, role }));
    invalid(() => parseV2ProjectTeamMember({ ...f.teamMember, teamRole: role }));
  }
  for (const status of ["pending", "deleted", "owner"]) invalid(() => parseV2ProjectMember({ ...f.member, status }));
  const serviceGrant = parseV2ProjectJoinGrant({ ...f.grant, role: "service", projects: [{ projectId: f.identity.projectId, actions: ["project", "import"] }] },
    f.operationScope);
  expect(serviceGrant.role).toBe("service");
  expect("teamRole" in serviceGrant).toBe(false);
  expect(parseV2ProjectTeamMember(f.teamMember).teamRole).toBe("member");
});

test("request-bound operation identity and CAS conflict current cannot drift", () => {
  const f = createV2ProjectsFixtures();
  for (const endpoint of ["create", "operation", "creatorCredential"] as const) {
    for (const key of ["centerId", "teamId", "operationId", "personId", "instanceId"] as const) {
      invalid(() => parseV2ProjectsResponse(endpoint, V2_PROJECTS_SUCCESS_STATUS[endpoint], f.responses[endpoint], { ...f.scopes[endpoint], [key]: "other" }));
      const missing = { ...f.scopes[endpoint] }; delete missing[key];
      invalid(() => parseV2ProjectsResponse(endpoint, V2_PROJECTS_SUCCESS_STATUS[endpoint], f.responses[endpoint], missing));
    }
  }
  for (const [endpoint, body] of [["update", f.errors.projectConflict], ["create", f.errors.dedupMismatch],
    ["creatorCredential", f.errors.operationConflict]] as const) {
    expect(parseV2ProjectsResponse(endpoint, 409, body, f.scopes[endpoint])).toEqual(body);
    invalid(() => parseV2ProjectsResponse(endpoint, 409, { ...body, current: null }, f.scopes[endpoint]));
    invalid(() => parseV2ProjectsResponse(endpoint, 409, { ...body, current: { ...body.current, teamId: "other" } }, f.scopes[endpoint]));
  }
  invalid(() => parseV2ProjectsResponse("creatorCredential", 409, f.errors.dedupMismatch, f.operationScope));
  invalid(() => parseV2ProjectsResponse("update", 409, f.errors.operationConflict, f.identity));
  invalid(() => parseV2ProjectsResponse("create", 409, f.errors.projectConflict, f.scopes.create));
  invalid(() => parseV2ProjectsResponse("members", 409, f.errors.projectConflict, f.identity));
  invalid(() => parseV2ProjectsResponse("creatorCredential", 409,
    { ...f.errors.operationConflict, current: { ...f.operation, instanceId: "other" } }, f.operationScope));
});

test("creator recovery state is central, rev/digest survive; queries never return secrets", () => {
  const f = createV2ProjectsFixtures();
  for (const state of ["code_issued", "credential_issued", "revoked"] as const) {
    const operation = { ...f.operation, state, rev: 3, updatedAt: 2000 };
    const parsed = parseV2ProjectsResponse("operation", 200, { ...f.responses.operation, operation }, f.scopes.operation);
    expect(parsed.ok && parsed.operation.paramsDigest).toBe(f.operation.paramsDigest);
    expect(parsed.ok && parsed.operation.rev).toBe(3);
    if (state !== "code_issued") {
      expect(parseV2ProjectsResponse("create", 201, { ...f.responses.create, operation, creatorInvite: null }, f.scopes.create).ok).toBe(true);
      invalid(() => parseV2ProjectsResponse("creatorCredential", 200, { ...f.responses.creatorCredential, operation }, f.operationScope));
    }
  }
  for (const field of ["bearer", "code", "credential", "creatorInvite"]) {
    invalid(() => parseV2ProjectsResponse("operation", 200, { ...f.responses.operation, [field]: "sensitive" }, f.scopes.operation));
  }
  expect(f.operation.paramsDigest).toBe(v2ObjectDigest({ name: f.project.name, id: f.project.projectId }));
  expect(f.operation.paramsDigest).not.toBe(v2ObjectDigest({ name: "changed", id: f.project.projectId }));
  invalid(() => parseV2ProjectsResponse("create", 201, { ...f.responses.create, creatorInvite: null }, f.scopes.create));
  invalid(() => parseV2ProjectsResponse("creatorCredential", 200,
    { ...f.responses.creatorCredential, creatorInvite: { ...f.creatorInvite, instanceId: null } }, f.operationScope));
  invalid(() => parseV2ProjectOperation({ ...f.operation, paramsDigest: "not-a-digest" }));
});

test("new joined-project metadata requires exact scoped grant; old absent metadata is unsupported", () => {
  const f = createV2ProjectsFixtures();
  expect(parseV2ProjectJoinGrant(f.grant, f.operationScope)).toEqual(f.grant);
  const { project: _display, ...legacy } = f.grant;
  invalid(() => parseV2ProjectJoinGrant(legacy, f.operationScope), "unavailable");
  for (const key of ["centerId", "teamId", "projectId", "personId", "instanceId"] as const) {
    invalid(() => parseV2ProjectJoinGrant(f.grant, { ...f.operationScope, [key]: "other" }));
    const missing = { ...f.operationScope }; delete missing[key];
    invalid(() => parseV2ProjectJoinGrant(f.grant, missing));
  }
  for (const bad of [
    { ...f.grant, project: { ...f.display, projectId: "other" } },
    { ...f.grant, project: { ...f.display, teamId: "other" } },
    { ...f.grant, project: { ...f.display, name: "" } },
    { ...f.grant, project: { ...f.display, dirs: ["/fake"] } },
    { ...f.grant, role: "owner" }, { ...f.grant, teamRole: "owner" }, { ...f.grant, bearer: "invalid" },
    { ...f.grant, projects: [] }, { ...f.grant, projects: [...f.grant.projects, { projectId: "other", actions: ["read"] }] },
    { ...f.grant, projects: [{ projectId: f.identity.projectId, actions: ["read", "read"] }] },
  ]) invalid(() => parseV2ProjectJoinGrant(bad, f.operationScope));
});

test("invites keep strict JN1 encoding, recipient/creator identity and expiration", () => {
  const f = createV2ProjectsFixtures();
  for (const code of ["invalid", ` ${f.invite.code}`, `${f.invite.code} `]) invalid(() => parseV2ProjectInvite({ ...f.invite, code }));
  invalid(() => parseV2ProjectInvite({ ...f.invite, centerId: "center-other" }));
  invalid(() => parseV2ProjectInvite({ ...f.invite, codeId: "3".repeat(32) }));
  invalid(() => parseV2ProjectsResponse("invite", 201, { ...f.responses.invite, member: { ...f.member, status: "active" } }, f.scopes.invite));
  invalid(() => parseV2ProjectsResponse("invite", 201, { ...f.responses.invite, invite: { ...f.invite, personId: "other" } }, f.scopes.invite));
  invalid(() => parseV2ProjectsResponse("creatorCredential", 200,
    { ...f.responses.creatorCredential, creatorInvite: { ...f.creatorInvite, expiresAt: 1000 } }, f.operationScope));
});

test("fixed error responses reject secrets, unsupported codes and mismatched HTTP status", () => {
  const f = createV2ProjectsFixtures();
  for (const [status, error] of [[400, "invalid_field"], [401, "unauthenticated"], [401, "bad_signature"],
    [403, "forbidden"], [404, "not_found"], [503, "unavailable"]] as const) {
    const body = { ok: false, v: 2, error, message: error } as const;
    expect(parseV2ProjectsResponse("update", status, body, f.identity)).toEqual(body);
    for (const extra of [{ bearer: f.grant.bearer }, { current: f.project }, { message: f.creatorInvite.code }, { error: "unexpected" }, { v: 1 }]) {
      invalid(() => parseV2ProjectsResponse("update", status, { ...body, ...extra }, f.identity));
    }
    invalid(() => parseV2ProjectsResponse("update", 500, body, f.identity));
  }
  for (const secret of [f.creatorInvite.code, f.grant.bearer]) {
    try { parseV2ProjectRecord({ ...f.project, rev: secret }); } catch (e) {
      expect(String(e)).not.toContain(secret);
      expect((e as Error).message).toBe("invalid_field");
    }
  }
});

test("consumer cannot use arbitrary endpoints, duplicate members or empty patches", () => {
  const f = createV2ProjectsFixtures();
  for (const endpoint of ["ownerBootstrap", "__proto__", "toString"] as unknown as V2ProjectsEndpoint[]) {
    invalid(() => parseV2ProjectsRequest(endpoint, {}));
    invalid(() => parseV2ProjectsResponse(endpoint, 200, {}, f.identity));
  }
  invalid(() => parseV2ProjectsRequest("update", { ...f.identity, rev: 1 }));
  invalid(() => parseV2ProjectsRequest("create", { ...f.requests.create, teamRole: "owner" }));
  expect(parseV2ProjectsRequest("create", { centerId: f.identity.centerId, teamId: f.identity.teamId, operationId: "op", name: "项目" })).toHaveProperty("name", "项目");
  expect(parseV2ProjectsRequest("invite", { ...f.identity, code: "new-person" })).toHaveProperty("code", "new-person");
  invalid(() => parseV2ProjectsRequest("invite", { ...f.identity, code: "new-person", personId: "person" }));
  invalid(() => parseV2ProjectsResponse("list", 200, { ...f.responses.list, projects: [f.project, f.project] }, f.scopes.list));
  invalid(() => parseV2ProjectsResponse("members", 200, { ...f.responses.members, members: [f.member, f.member] }, f.identity));
  invalid(() => parseV2ProjectsResponse("members", 200, { ...f.responses.members, members: new Array(1) }, f.identity));
  invalid(() => parseV2ProjectsResponse("removeMember", 200, { ...f.responses.removeMember, member: { ...f.member, status: "removed" } }, f.scopes.removeMember));
  invalid(() => parseV2ProjectsResponse("members", 200, f.responses.members, f.scopes.list));
  const second = createV2ProjectsFixtures();
  f.responses.list.projects[0]!.name = "mutated";
  expect(second.responses.list.projects[0]!.name).toBe("合成项目 B");
});
