/** N9B: snapshot team / teamDirectory / teamRole and the team rename route, over N9K fixtures and a fake center. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { createV2ProjectsFixtures, createV2ProjectsTeamFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { parseSharedLedgerJoinCode } from "../src/lib/shared-ledger-join.js";
import { sharedProjectsClientPorts } from "../src/bridge/local-api/shared-projects-client.js";
import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot.js";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects.js";
import { SharedProjectsError, SharedTeamConflict, type ProjectPerson, type SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" };
const p = createV2ProjectsFixtures(), t = createV2ProjectsTeamFixtures();
const person: ProjectPerson = { subject: "owner:self", kind: "person", ...t.team, personId: t.self.personId, instanceId: "instance-demo" };
const local = { projects: [{ id: "local-a", name: "A", dirs: ["/synthetic/a"], personal: false }], peers: [] };
const BEARER = "S".repeat(43);

function fake(team?: SharedProjectsPorts["team"]) {
  const calls: string[] = [];
  const d = {
    person: async () => person, list: async () => [p.project], bindings: () => [{ ...t.team, projectId: p.project.projectId, localProjectId: "local-a" }],
    members: async () => [{ ...p.member, role: "owner" as const }],
    ...(team ? { team: async (who: ProjectPerson) => { calls.push("team"); return team(who); } } : {}),
  } as unknown as SharedProjectsPorts;
  const request = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://fixture/api/v1/shared-projects${path}`);
    return handleSharedProjectsApi(new Request(url.toString(), { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), url,
      { auth: async () => owner, ports: d, localSnapshot: async () => local });
  };
  return { d, calls, request };
}
const rejecting = (status: number) => async () => { throw new SharedProjectsError(status, "SECRET_RESPONSE"); };
const strip = ({ team: _t, teamDirectory: _d, teamRole: _r, ...rest }: Record<string, unknown>) => rest;

describe("N9B snapshot team fields come only from the center's team read", () => {
  test("available: team name/code/rev, active directory rows and teamRole from self", async () => {
    const s = await sharedProjectsSnapshot(fake(async () => t.responses.team).d, local);
    expect(s.team).toEqual({ available: true, value: { name: t.record.name, code: t.record.code, rev: t.record.rev } });
    expect(s.teamDirectory).toEqual({ available: true,
      members: [t.owner, t.self].map(m => ({ personId: m.personId, code: m.code, teamRole: m.teamRole })) });
    expect(s.teamRole).toEqual({ available: true, value: "member" });
    const unnamed = await sharedProjectsSnapshot(fake(async () => ({ ...t.responses.team, team: t.unnamed })).d, local);
    expect(unnamed.team).toEqual({ available: true, value: { name: null, code: t.record.code, rev: 1 } });
  });
  test("project ownership, bindings, grant role, query and body cannot raise teamRole", async () => {
    const w = fake(async () => t.responses.team);
    const s = await (await w.request("GET", "/snapshot"))!.json() as { teamRole: unknown; projects: { projectRole: unknown }[] };
    expect(s.projects[0]!.projectRole).toEqual({ available: true, value: "owner" });
    expect(s.teamRole).toEqual({ available: true, value: "member" });
    w.calls.length = 0;
    expect((await w.request("GET", "/snapshot?teamRole=owner"))!.status).toBe(400);
    expect((await w.request("POST", "/snapshot", { teamRole: "owner" }))!.status).not.toBe(200);
    expect(w.calls).toEqual([]);
  });
  test("self of another person, removed rows, cross-team rows and extra fields: all three unavailable", async () => {
    const bodies = [
      { ...t.responses.team, self: t.owner },
      { ...t.responses.team, members: [{ ...t.owner, status: "removed" }, t.self] },
      { ...t.responses.team, members: [{ ...t.owner, teamId: "other-team" }, t.self] },
      { ...t.responses.team, bearer: BEARER },
      { ...t.responses.team, team: { ...t.record, name: "a\u0000b" } },
    ];
    for (const body of bodies) {
      const s = await sharedProjectsSnapshot(fake(async () => body as typeof t.responses.team).d, local);
      for (const field of [s.team, s.teamDirectory, s.teamRole]) expect(field).toEqual({ available: false, reason: "center_team_read_invalid" });
      expect(s.projects.length).toBe(1);
      expect(JSON.stringify(s)).not.toContain(BEARER);
    }
  });
  test("old center 404 leaves every other field byte-identical to the pre-N9B snapshot", async () => {
    const before = await sharedProjectsSnapshot(fake().d, local);
    expect(before.teamRole).toEqual({ available: false, reason: "center_team_role_read_contract_unavailable" });
    const after = await sharedProjectsSnapshot(fake(rejecting(404)).d, local);
    expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
    for (const field of [after.team, after.teamDirectory, after.teamRole]) expect(field).toEqual({ available: false, reason: "center_team_read_not_found" });
  });
  test("403 / 503 / thrown transport errors give fixed reasons and keep the project list", async () => {
    const cases = [[rejecting(403), "center_team_read_forbidden"], [rejecting(503), "center_team_read_unavailable"],
      [async () => { throw new Error("SECRET_RESPONSE"); }, "center_team_read_unavailable"]] as const;
    for (const [team, reason] of cases) {
      const s = await sharedProjectsSnapshot(fake(team).d, local);
      expect(s.teamRole).toEqual({ available: false, reason });
      expect(s.projects.map(x => x.projectId)).toEqual([p.project.projectId]);
      expect(JSON.stringify(s)).not.toContain("SECRET_RESPONSE");
    }
  });
});

describe("N9B PATCH /api/v1/shared-projects/teams/current", () => {
  function renaming(updateTeam?: SharedProjectsPorts["updateTeam"]) {
    const w = fake(), seen: unknown[] = [];
    if (updateTeam) w.d.updateTeam = async (who, input) => { seen.push(input); return updateTeam(who, input); };
    return { ...w, seen };
  }
  test("renames with CAS rev and returns only name/code/rev", async () => {
    const w = renaming(async () => t.responses.teamUpdate.team);
    const res = await w.request("PATCH", "/teams/current", { rev: 1, name: t.requests.teamUpdate.name });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, team: { name: t.requests.teamUpdate.name, code: t.record.code, rev: 2 } });
    expect(w.seen).toEqual([{ rev: 1, name: t.requests.teamUpdate.name }]);
  });
  test("409 returns the canonical current team only; center text never leaks", async () => {
    const w = renaming(async () => { throw new SharedTeamConflict({ ...t.record, rev: 3 }); });
    const res = await w.request("PATCH", "/teams/current", { rev: 1, name: "x" });
    expect(res!.status).toBe(409);
    expect(await res!.json()).toEqual({ ok: false, current: { name: t.record.name, code: t.record.code, rev: 3 }, code: "team_conflict" });
    const other = renaming(async () => { throw new SharedTeamConflict({ ...t.record, teamId: "other-team" }); });
    expect(await (await other.request("PATCH", "/teams/current", { rev: 1, name: "x" }))!.json()).toEqual({ ok: false, code: "team_conflict" });
    const failing = renaming(rejecting(403));
    const forbidden = await failing.request("PATCH", "/teams/current", { rev: 1, name: "x" });
    expect(forbidden!.status).toBe(403);
    expect(await forbidden!.text()).not.toContain("SECRET_RESPONSE");
  });
  test("body cannot carry identity or role; invalid name/rev rejected before the center", async () => {
    const w = renaming(async () => t.responses.teamUpdate.team);
    for (const body of [{ rev: 1, name: "x", personId: "person-owner" }, { rev: 1, name: "x", teamRole: "owner" }, { rev: 0, name: "x" },
      { rev: 1.5, name: "x" }, { rev: 1, name: " " }, { rev: 1, name: "中".repeat(65) }, { rev: 1, name: "a\u0007b" }, { rev: 1 }]) {
      expect((await w.request("PATCH", "/teams/current", body))!.status).toBe(400);
    }
    expect(w.seen).toEqual([]);
    expect((await w.request("GET", "/teams/current"))!.status).toBe(405);
  });
  test("adapter without updateTeam fails closed", async () => {
    const res = await renaming().request("PATCH", "/teams/current", { rev: 1, name: "x" });
    expect(res!.status).toBe(503);
    expect(await res!.json()).toEqual({ ok: false, code: "team_update_unavailable" });
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Real N4 adapter + N3 client against a fake center; the credential's actions decide project-level authority. */
async function center(respond: (method: string, path: string) => Response, actions: ("read" | "project")[] = ["read", "project"]) {
  const dir = mkdtempSync(join(tmpdir(), "n9b-team-")); roots.push(dir);
  const instanceId = instanceIdSync(dir); instanceKeySync(dir);
  const source = { ...t.team, projectId: "original-a", localProjectId: "original-a" };
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "original-a", name: "A", dirs: [] }] }));
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals: [owner] }));
  await setSharedLedgerBinding(source, dir);
  await writeSharedLedgerCredential({ ...source, localSubject: owner.id, kind: "person", baseUrl: "https://synthetic.example/",
    personId: t.self.personId, instanceId, bearer: BEARER, projects: [{ projectId: source.projectId, actions }] }, dir);
  const calls: string[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push(`${init.method} ${url.pathname}`);
    if (url.pathname === "/v1/projects") return Response.json({ ...p.responses.list, projects: [] });
    return respond(init.method!, url.pathname);
  }) as unknown as typeof fetch;
  const ports = sharedProjectsClientPorts(owner, source.projectId, dir, fetcher);
  const request = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://fixture/api/v1/shared-projects${path}`);
    return handleSharedProjectsApi(new Request(url.toString(), { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), url,
      { auth: async () => owner, ports, localSnapshot: async () => local });
  };
  return { calls, request };
}

describe("N9B real adapter against a fake center", () => {
  test("snapshot reads GET /v1/team and shows the signed caller's own role", async () => {
    const c = await center(() => Response.json({ ...t.responses.team, self: { ...t.self, teamRole: "owner" },
      members: [t.owner, { ...t.self, teamRole: "owner" }] }));
    const s = await (await c.request("GET", "/snapshot"))!.json() as Record<string, unknown>;
    expect(s.teamRole).toEqual({ available: true, value: "owner" });
    expect(c.calls).toContain("GET /v1/team");
    expect(JSON.stringify(s)).not.toContain(BEARER);
  });
  test("old center 404 / 403 / 503 / garbage → unavailable with fixed reasons", async () => {
    const cases = [[404, "center_team_read_not_found"], [403, "center_team_read_forbidden"], [503, "center_team_read_unavailable"]] as const;
    for (const [status, reason] of cases) {
      const c = await center(() => Response.json({ error: "SECRET_RESPONSE" }, { status }));
      const s = await (await c.request("GET", "/snapshot"))!.json() as Record<string, unknown>;
      expect(s.teamRole).toEqual({ available: false, reason });
      expect(JSON.stringify(s)).not.toContain("SECRET_RESPONSE");
    }
    const garbage = await center(() => Response.json({ ...t.responses.team, self: t.owner, note: "SECRET_RESPONSE" }));
    const s = await (await garbage.request("GET", "/snapshot"))!.json() as Record<string, unknown>;
    expect(s.teamRole).toEqual({ available: false, reason: "center_team_read_unavailable" });
  });
  test("rename PATCHes /v1/team with project authority; a read-only credential never reaches the center", async () => {
    const c = await center((method, path) => method === "PATCH" && path === "/v1/team"
      ? Response.json(t.responses.teamUpdate) : Response.json({}, { status: 404 }));
    const res = await c.request("PATCH", "/teams/current", { rev: 1, name: t.requests.teamUpdate.name });
    expect(res!.status).toBe(200);
    expect(c.calls).toEqual(["PATCH /v1/team"]);
    const conflict = await center(() => Response.json(t.errors.teamConflict, { status: 409 }));
    const raced = await conflict.request("PATCH", "/teams/current", { rev: 1, name: "x" });
    expect([raced!.status, ((await raced!.json()) as { current: { rev: number } }).current.rev]).toEqual([409, 2]);
    const readOnly = await center(() => Response.json(t.responses.teamUpdate), ["read"]);
    expect((await readOnly.request("PATCH", "/teams/current", { rev: 1, name: "x" }))!.status).not.toBe(200);
    expect(readOnly.calls).toEqual([]);
  });
});

describe("N9B join codes never reach the page through team/member ids", () => {
  const JOIN = p.creatorInvite.code;
  test("a parseable join code in team.code, another member's code or personId degrades all three fields", async () => {
    expect(parseSharedLedgerJoinCode(JOIN)).toBeTruthy();
    const bodies = [
      { ...t.responses.team, team: { ...t.record, code: JOIN } },
      { ...t.responses.team, members: [{ ...t.owner, code: JOIN }, t.self] },
      { ...t.responses.team, members: [{ ...t.owner, personId: JOIN }, t.self] },
    ];
    for (const body of bodies) {
      const c = await center(() => Response.json(body));
      const s = await (await c.request("GET", "/snapshot"))!.json() as Record<string, unknown>;
      for (const field of [s.team, s.teamDirectory, s.teamRole]) expect(field).toEqual({ available: false, reason: "center_team_read_invalid" });
      expect(c.calls).toContain("GET /v1/team");
      expect(JSON.stringify(s)).not.toContain(JOIN);
    }
  });
  test("rename success and 409 current never echo a join code", async () => {
    const ok = renamingWith(async () => ({ ...t.responses.teamUpdate.team, code: JOIN }));
    const res = await ok.request("PATCH", "/teams/current", { rev: 1, name: "x" });
    expect(res!.status).toBe(503);
    expect(await res!.text()).not.toContain(JOIN);
    const raced = renamingWith(async () => { throw new SharedTeamConflict({ ...t.record, code: JOIN, rev: 3 }); });
    const conflict = await raced.request("PATCH", "/teams/current", { rev: 1, name: "x" });
    expect(conflict!.status).toBe(409);
    expect(await conflict!.json()).toEqual({ ok: false, code: "team_conflict" });
  });
});
function renamingWith(updateTeam: SharedProjectsPorts["updateTeam"]) {
  const w = fake();
  w.d.updateTeam = updateTeam;
  return w;
}
