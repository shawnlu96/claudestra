import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  parseV2TeamRecord, parseV2TeamDirectoryMember, parseV2ProjectsTeamRequest, parseV2ProjectsTeamResponse,
  parseV2ProjectsRequest, parseV2ProjectsResponse, V2_PROJECTS_REQUEST_SCHEMAS, V2_PROJECTS_SUCCESS_SCHEMAS, V2_PROJECTS_SUCCESS_STATUS,
  V2_PROJECTS_TEAM_REQUEST_SCHEMAS, V2_PROJECTS_TEAM_SUCCESS_SCHEMAS, V2_PROJECTS_TEAM_SUCCESS_STATUS,
  type V2ProjectsEndpoint, type V2ProjectsTeamResponses,
} from "../src/lib/shared-ledger-contract-v2-projects.js";
import { createV2ProjectsFixtures, createV2ProjectsTeamFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { V2ContractError, type V2ErrorCode } from "../src/lib/shared-ledger-contract-v2-validation.js";

function invalid(fn: () => unknown, code: V2ErrorCode = "invalid_field") {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(V2ContractError);
  expect((caught as V2ContractError).code).toBe(code);
  expect((caught as Error).message).toBe(code);
}
const teamEndpoints = ["team", "teamUpdate"] as const;

describe("N9K acceptance 1: team read contract positive round-trip and shared fixtures", () => {
  test("exact team endpoint maps and statuses", () => {
    expect(Object.keys(V2_PROJECTS_TEAM_REQUEST_SCHEMAS)).toEqual([...teamEndpoints]);
    expect(Object.keys(V2_PROJECTS_TEAM_SUCCESS_SCHEMAS)).toEqual([...teamEndpoints]);
    expect(V2_PROJECTS_TEAM_SUCCESS_STATUS).toEqual({ team: 200, teamUpdate: 200 });
  });
  for (const endpoint of teamEndpoints) {
    test(`${endpoint}: request/response round-trip field by field`, () => {
      const f = createV2ProjectsTeamFixtures();
      expect(parseV2ProjectsTeamRequest(endpoint, f.requests[endpoint])).toEqual(f.requests[endpoint]);
      const parsed: V2ProjectsTeamResponses[typeof endpoint] = parseV2ProjectsTeamResponse(endpoint,
        V2_PROJECTS_TEAM_SUCCESS_STATUS[endpoint], f.responses[endpoint], f.scopes[endpoint]);
      expect(parsed).toEqual(f.responses[endpoint]);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(f.responses[endpoint]));
      for (const [key, value] of Object.entries(f.responses[endpoint])) expect((parsed as Record<string, unknown>)[key]).toEqual(value);
      for (const body of [f.errors.forbidden, f.errors.notFound]) {
        const status = body.error === "forbidden" ? 403 : 404;
        expect(parseV2ProjectsTeamResponse(endpoint, status, body, f.scopes[endpoint])).toEqual(body);
      }
    });
  }
  test("team record: named, unnamed (null) and directory rows round-trip; teamUpdate 409 carries current team", () => {
    const f = createV2ProjectsTeamFixtures();
    for (const row of [f.record, f.unnamed]) expect(parseV2TeamRecord(row)).toEqual(row);
    for (const row of [f.self, f.owner]) expect(parseV2TeamDirectoryMember(row)).toEqual(row);
    const unnamed = { ...f.responses.team, team: f.unnamed };
    expect(parseV2ProjectsTeamResponse("team", 200, unnamed, f.scopes.team)).toEqual(unnamed);
    const solo = { ...f.responses.team, members: [f.self] };
    expect(parseV2ProjectsTeamResponse("team", 200, solo, f.scopes.team)).toEqual(solo);
    expect(parseV2TeamRecord({ ...f.record, name: "中".repeat(64) }).name).toHaveLength(64);
    expect(parseV2ProjectsTeamResponse("teamUpdate", 409, f.errors.teamConflict, f.scopes.teamUpdate)).toEqual(f.errors.teamConflict);
  });
  test("fixtures are fresh, synthetic and carry no real peer names or ids", () => {
    const a = createV2ProjectsTeamFixtures(), b = createV2ProjectsTeamFixtures();
    expect(a).toEqual(b);
    expect(a.responses).not.toBe(b.responses);
    const text = JSON.stringify(a);
    for (const id of [a.self.personId, a.owner.personId, a.team.teamId]) expect(id).toMatch(/^(person|team)-(demo|owner)$/);
    expect(text).not.toMatch(/MacBook|peer:|@|\/Users\//);
    expect(a.invalidRequests.length).toBeGreaterThan(0);
    expect(a.invalidResponses.length).toBeGreaterThan(0);
    expect(a.invalidScopes.length).toBeGreaterThan(0);
  });
});

describe("N9K acceptance 2: negatives fail closed", () => {
  test("every shared invalid request, response and scope sample is rejected", () => {
    const f = createV2ProjectsTeamFixtures();
    for (const probe of f.invalidRequests) invalid(() => parseV2ProjectsTeamRequest(probe.endpoint, probe.body));
    for (const probe of f.invalidResponses) {
      invalid(() => parseV2ProjectsTeamResponse(probe.endpoint, probe.status, probe.body, f.scopes[probe.endpoint]));
    }
    for (const probe of f.invalidScopes) {
      invalid(() => parseV2ProjectsTeamResponse("team", 200, f.responses.team, probe.scope));
    }
  });
  test("extra keys anywhere in requests or responses", () => {
    const f = createV2ProjectsTeamFixtures();
    for (const endpoint of teamEndpoints) {
      invalid(() => parseV2ProjectsTeamRequest(endpoint, { ...f.requests[endpoint], caller: "person-demo" }));
      invalid(() => parseV2ProjectsTeamResponse(endpoint, 200, { ...f.responses[endpoint], extra: 1 }, f.scopes[endpoint]));
      invalid(() => parseV2ProjectsTeamResponse(endpoint, 200,
        { ...f.responses[endpoint], team: { ...f.responses[endpoint].team, extra: 1 } }, f.scopes[endpoint]));
      for (const bad of [null, [], "x", { ...f.responses[endpoint], v: 1 }]) {
        invalid(() => parseV2ProjectsTeamResponse(endpoint, 200, bad, f.scopes[endpoint]));
      }
    }
    invalid(() => parseV2ProjectsTeamResponse("team", 200, { ...f.responses.team, self: { ...f.self, extra: 1 } }, f.scopes.team));
    for (const key of Object.keys(f.record)) {
      const missing: Record<string, unknown> = { ...f.record }; delete missing[key];
      invalid(() => parseV2TeamRecord(missing));
    }
    for (const key of Object.keys(f.self)) {
      const missing: Record<string, unknown> = { ...f.self }; delete missing[key];
      invalid(() => parseV2TeamDirectoryMember(missing));
    }
    invalid(() => parseV2TeamDirectoryMember({ ...f.self, status: "active" }));
  });
  test("self must be one of members; members share center/team and unique personId", () => {
    const f = createV2ProjectsTeamFixtures();
    const bodies = [
      { ...f.responses.team, members: [f.owner] },
      { ...f.responses.team, members: [] },
      { ...f.responses.team, self: { ...f.self, code: "other-code" } },
      { ...f.responses.team, members: [{ ...f.owner, teamId: "other-team" }, f.self] },
      { ...f.responses.team, members: [{ ...f.owner, centerId: `center-${"2".repeat(32)}` }, f.self] },
      { ...f.responses.team, self: { ...f.self, teamId: "other-team" }, members: [f.owner, { ...f.self, teamId: "other-team" }] },
      { ...f.responses.team, members: [f.owner, f.self, f.self] },
      { ...f.responses.team, members: [f.owner, f.self, { ...f.owner, code: "demo-owner-2" }] },
    ];
    for (const body of bodies) invalid(() => parseV2ProjectsTeamResponse("team", 200, body, f.scopes.team));
  });
  test("team name blank, untrimmed-empty, control chars or over the length cap", () => {
    const f = createV2ProjectsTeamFixtures();
    for (const name of ["", " ", "\n\t", "　".repeat(0) + "  \t ", "中".repeat(65), "secret\0", 1]) {
      invalid(() => parseV2TeamRecord({ ...f.record, name }));
      invalid(() => parseV2ProjectsTeamRequest("teamUpdate", { ...f.requests.teamUpdate, name }));
    }
    invalid(() => parseV2ProjectsTeamRequest("teamUpdate", { ...f.requests.teamUpdate, name: null }));
    for (const rev of [0, -1, 1.5, "1"]) invalid(() => parseV2ProjectsTeamRequest("teamUpdate", { ...f.requests.teamUpdate, rev }));
  });
  test("requests never carry teamRole or personId", () => {
    const f = createV2ProjectsTeamFixtures();
    for (const endpoint of teamEndpoints) {
      for (const key of ["teamRole", "personId", "role", "instanceId"]) {
        invalid(() => parseV2ProjectsTeamRequest(endpoint, { ...f.requests[endpoint], [key]: key === "teamRole" ? "owner" : "person-demo" }));
      }
    }
  });
  test("expectedScope: team requires matching personId; teamUpdate takes team scope only", () => {
    const f = createV2ProjectsTeamFixtures();
    invalid(() => parseV2ProjectsTeamResponse("team", 200, f.responses.team, f.team));
    invalid(() => parseV2ProjectsTeamResponse("team", 200, f.responses.team, { ...f.team, personId: f.owner.personId }));
    invalid(() => parseV2ProjectsTeamResponse("team", 403, f.errors.forbidden, f.team));
    for (const key of ["centerId", "teamId"] as const) {
      invalid(() => parseV2ProjectsTeamResponse("team", 200, f.responses.team, { ...f.scopes.team, [key]: "other" }));
      invalid(() => parseV2ProjectsTeamResponse("teamUpdate", 200, f.responses.teamUpdate, { ...f.scopes.teamUpdate, [key]: "other" }));
      invalid(() => parseV2ProjectsTeamResponse("teamUpdate", 409,
        { ...f.errors.teamConflict, current: { ...f.errors.teamConflict.current, [key]: "other" } }, f.scopes.teamUpdate));
    }
    for (const key of ["projectId", "operationId", "instanceId", "personId"] as const) {
      invalid(() => parseV2ProjectsTeamResponse("teamUpdate", 200, f.responses.teamUpdate, { ...f.scopes.teamUpdate, [key]: "demo-b" }));
    }
  });
  test("unknown endpoints and project endpoints are not accepted by the team parsers (and vice versa)", () => {
    const f = createV2ProjectsTeamFixtures();
    invalid(() => parseV2ProjectsTeamRequest("list" as never, f.requests.team));
    invalid(() => parseV2ProjectsTeamResponse("toString" as never, 200, f.responses.team, f.scopes.team));
    invalid(() => parseV2ProjectsRequest("team" as never, f.requests.team));
    invalid(() => parseV2ProjectsResponse("team" as never, 200, f.responses.team, f.scopes.team));
  });
});

describe("N9K acceptance 3: existing project endpoints are byte-for-byte unchanged", () => {
  const endpoints = ["list", "create", "update", "members", "invite", "removeMember", "teamOwners", "operation", "creatorCredential"] as const;
  test("endpoint maps keep their exact keys", () => {
    expect(Object.keys(V2_PROJECTS_REQUEST_SCHEMAS)).toEqual([...endpoints]);
    expect(Object.keys(V2_PROJECTS_SUCCESS_SCHEMAS)).toEqual([...endpoints]);
    expect(Object.keys(V2_PROJECTS_SUCCESS_STATUS)).toEqual([...endpoints]);
  });
  test("fixtures and parse results hash to the pre-N9K baseline (510825c0)", () => {
    const f = createV2ProjectsFixtures();
    const parsed = Object.fromEntries(endpoints.map(e => [e, {
      request: parseV2ProjectsRequest(e, f.requests[e]),
      response: parseV2ProjectsResponse(e as V2ProjectsEndpoint, V2_PROJECTS_SUCCESS_STATUS[e], f.responses[e], f.scopes[e]),
    }]));
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(sha(JSON.stringify(f))).toBe("83d096ea38689bfd427dd27df41594de9004c1ff2358f1a20eb13c64ba59a346");
    expect(sha(JSON.stringify(parsed))).toBe("cac7b9fd858c09e48affb525ca10425c21d12d26812d267545bd0bee473d8a9c");
  });
});
