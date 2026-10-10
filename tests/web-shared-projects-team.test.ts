/** N9W: N9B team name / directory / rename consumed by the web model, over the actual N4 producer and route with N9K fixtures. */
import { describe, expect, test } from "bun:test";
import { ProjectFailure, teamDisplayName, type ProjectTeam } from "../web/lib/shared-projects-model";
import { parseProjectSnapshot } from "../web/lib/shared-projects-parse";
import { projectSourceSnapshot } from "../web/lib/shared-projects-source";
import { sharedProjectsApi, type ProjectRequest } from "../web/lib/shared-projects-api";
import { sharedProjectsByBindings } from "../web/lib/shared-projects-bindings";
import { ApiError } from "../web/lib/api/client";
import { createV2ProjectsFixtures, createV2ProjectsTeamFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects";
import { SharedTeamConflict, type SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";

const p = createV2ProjectsFixtures(), t = createV2ProjectsTeamFixtures();
const SENTINEL = "team-code-sentinel-n9w";
const signal = () => new AbortController().signal;
const ownerRead = (record = t.record) => ({ ...t.responses.team, team: { ...record, code: SENTINEL },
  self: { ...t.self, teamRole: "owner" as const }, members: [t.owner, { ...t.self, teamRole: "owner" as const },
    { ...t.self, personId: "person-other", code: "demo-other" }] });
const local = { projects: [{ id: "local-a", name: "本机名", dirs: [], personal: false }], peers: [] };

/** The actual producer and route; `team` / `updateTeam` are the only injected center reads. */
function bridge(team?: SharedProjectsPorts["team"], updateTeam?: SharedProjectsPorts["updateTeam"]) {
  const d = { person: async () => ({ ...p.person, ...p.requests.list, subject: "owner:self" }), list: async () => [p.project],
    members: async () => [p.member], bindings: () => [{ ...p.identity, localProjectId: "local-a" }],
    ...(team ? { team } : {}), ...(updateTeam ? { updateTeam } : {}) } as unknown as SharedProjectsPorts;
  const sent: { path: string; method?: string; json: unknown; header?: string }[] = [];
  const request: ProjectRequest = async (path, init) => {
    sent.push({ path, method: init.method, json: init.json, header: init.headers?.["x-shared-ledger-project"] });
    const url = new URL(`http://fixture/api/v1${path}`);
    const res = (await handleSharedProjectsApi(new Request(url.toString(), { method: init.method ?? "GET", headers: init.headers,
      ...(init.json ? { body: JSON.stringify(init.json) } : {}) }), url, { auth: async () => ({ id: "owner:self", role: "owner",
      agents: ["*"], manage: true, createdAt: "" }), ports: d, localSnapshot: async () => local }))!;
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new ApiError("synthetic-sensitive-sentinel", res.status, body, typeof body.code === "string" ? body.code : undefined);
    return body;
  };
  return { d, sent, request, raw: () => sharedProjectsSnapshot(d, local) };
}
const team = (over: Partial<ProjectTeam> = {}): ProjectTeam => ({ centerId: `center-${"1".repeat(26)}abc123`, teamId: "team-demo",
  personId: "person-demo", teamRole: "owner", team: { name: "合成团队", rev: 1 }, directory: null, ...over });

describe("team display name", () => {
  test("named, unnamed and unavailable; several centers add the short center tag in the same string", () => {
    expect(teamDisplayName(team(), [team()])).toBe("合成团队");
    expect(teamDisplayName(team({ team: { name: null, rev: 1 } }), [team()])).toBe("未命名团队 · team-demo");
    expect(teamDisplayName(team({ team: null }), [team()])).toBe("团队 team-demo（中心未提供显示名）");
    const other = team({ centerId: "center-other-fedcba" });
    expect(teamDisplayName(team(), [team(), other])).toBe("合成团队 · 中心 abc123");
    expect(teamDisplayName(team({ team: null }), [team(), other])).toBe("团队 team-demo（中心未提供显示名） · 中心 abc123");
    expect(teamDisplayName(team(), [team(), other])).not.toContain(team().centerId);
  });
});

describe("N9B snapshot consumption", () => {
  test("owner read projects name/rev/directory; never the team code and never the project name", async () => {
    const next = projectSourceSnapshot(await bridge(async () => ownerRead()).raw());
    expect(next.teams[0]).toMatchObject({ teamRole: "owner", team: { name: "合成团队", rev: 1 } });
    expect(next.teams[0]?.directory?.map(m => m.code)).toEqual(["demo-owner", "demo-person", "demo-other"]);
    expect(JSON.stringify(next)).not.toContain(SENTINEL);
    expect(teamDisplayName(next.teams[0]!, next.teams)).not.toBe(p.project.name);
    const unnamed = projectSourceSnapshot(await bridge(async () => ownerRead(t.unnamed)).raw());
    expect(teamDisplayName(unnamed.teams[0]!, unnamed.teams)).toBe("未命名团队 · team-demo");
    const unavailable = projectSourceSnapshot(await bridge().raw());
    expect(unavailable.teams[0]).toMatchObject({ team: null, directory: null, teamRole: null });
    expect(teamDisplayName(unavailable.teams[0]!, unavailable.teams)).not.toContain(p.project.name);
  });
  test("an old bridge without team keys is unavailable, not 502; names are null or at most 64 characters", async () => {
    const { team: _t, teamDirectory: _d, ...old } = await bridge(async () => ownerRead()).raw();
    expect(projectSourceSnapshot(old).teams[0]).toMatchObject({ team: null, directory: null, teamRole: "owner" });
    const base = { teams: [{ centerId: "c", teamId: "t", personId: "x", teamRole: null }], projects: [], localProjects: [], peers: [] };
    expect(parseProjectSnapshot(base).teams[0]?.team).toBeNull();
    expect(parseProjectSnapshot({ ...base, teams: [{ ...base.teams[0], team: { name: "中".repeat(64), rev: 2 } }] }).teams[0]?.team?.rev).toBe(2);
    for (const bad of [{ name: "中".repeat(65), rev: 1 }, { name: "", rev: 1 }, { name: "x", rev: 0 }]) {
      expect(() => parseProjectSnapshot({ ...base, teams: [{ ...base.teams[0], team: bad }] })).toThrow(ProjectFailure);
    }
  });
});

/** Two same-team bindings over one transport; `reads[i]` is the snapshot read through binding i. */
function twoBindings(reads: Record<string, unknown>[], projectIds = ["demo-b", "demo-c"]) {
  const headers: string[] = [];
  const port = sharedProjectsByBindings({ fp: "synthetic" }, async (path, init) => {
    if (path === "/shared-ledger/context") return { identities: projectIds.map(project => ({ center: p.identity.centerId,
      team: p.identity.teamId, project, person: p.person.personId, homeInstanceId: p.person.instanceId })) };
    const source = init.headers?.["x-shared-ledger-project"]!;
    headers.push(`${init.method ?? "GET"} ${path} ${source}`);
    if (init.method === "PATCH") return { ok: true, team: { name: "x", code: SENTINEL, rev: 9 } };
    return reads[projectIds.indexOf(source)];
  });
  return { port, headers };
}

describe("multiple bindings", () => {
  test("available beats unavailable and the higher rev wins in either order; role conflict still clears teamRole", async () => {
    const { raw } = bridge(async () => ownerRead({ ...t.record, name: "旧名", rev: 1 }));
    const older = await raw(), newer = await bridge(async () => ownerRead({ ...t.record, name: "新名", rev: 2 })).raw();
    const none = await bridge().raw();
    for (const reads of [[older, newer], [newer, older]]) {
      const next = await twoBindings(reads).port.list(signal());
      expect(next.teams).toHaveLength(1);
      expect(next.teams[0]?.team).toEqual({ name: "新名", rev: 2 });
      expect(next.teams[0]?.teamRole).toBe("owner");
    }
    for (const reads of [[none, older], [older, none]]) {
      const next = await twoBindings(reads).port.list(signal());
      expect(next.teams[0]?.team).toEqual({ name: "旧名", rev: 1 });
      expect(next.teams[0]?.directory).toHaveLength(3);
      expect(next.teams[0]?.teamRole).toBeNull();
    }
    const member = { ...newer, teamRole: { available: true, value: "member" } };
    expect((await twoBindings([older, member]).port.list(signal())).teams[0]?.teamRole).toBeNull();
  });
  test("rename goes through the binding whose own read is owner, with its project header", async () => {
    const owner = await bridge(async () => ownerRead()).raw(), none = await bridge().raw();
    const { port, headers } = twoBindings([none, owner]);
    const next = await port.list(signal());
    expect(next.teams[0]?.teamRole).toBeNull(); // The merged view hides the form; the port still keeps owner-only routing.
    headers.length = 0;
    expect(await port.updateTeam!(next.teams[0]!, { rev: 1, name: "新团队名" }, signal())).toEqual({ name: "x", rev: 9 });
    expect(headers).toEqual(["PATCH /shared-projects/teams/current demo-c"]);
    const member = twoBindings([none, none]);
    const unowned = await member.port.list(signal());
    member.headers.length = 0;
    await expect(member.port.updateTeam!(unowned.teams[0]!, { rev: 1, name: "x" }, signal())).rejects.toMatchObject({ status: 403 });
    expect(member.headers).toEqual([]);
  });
});

describe("team rename through the actual route", () => {
  const scope = { centerId: p.identity.centerId, teamId: p.identity.teamId };
  test("PATCH body is exactly {rev, name} with the source header; the reply drops the code", async () => {
    const seen: unknown[] = [];
    const b = bridge(async () => ownerRead(), async (_who, input) => { seen.push(input); return { ...t.record, name: input.name, rev: 2, code: SENTINEL }; });
    const port = sharedProjectsApi({ fp: "synthetic" }, p.project.projectId, b.request);
    await port.list(signal());
    expect(await port.updateTeam!(scope, { rev: 1, name: "新团队名" }, signal())).toEqual({ name: "新团队名", rev: 2 });
    expect(b.sent.at(-1)).toEqual({ path: "/shared-projects/teams/current", method: "PATCH", json: { rev: 1, name: "新团队名" }, header: "demo-b" });
    expect(seen).toEqual([{ rev: 1, name: "新团队名" }]);
  });
  test("409 with current offers it; 409 without current or project_conflict is unconfirmed; member never sends", async () => {
    const conflict = async (current: unknown) => {
      const b = bridge(async () => ownerRead(), async () => { throw new SharedTeamConflict(current as typeof t.record); });
      const port = sharedProjectsApi({ fp: "synthetic" }, p.project.projectId, b.request);
      await port.list(signal());
      return port.updateTeam!(scope, { rev: 1, name: "x" }, signal()).then(() => null, e => e as ProjectFailure);
    };
    const withCurrent = await conflict({ ...t.record, name: "同事改的名", rev: 3, code: SENTINEL });
    expect(withCurrent?.conflict).toEqual({ code: "team_conflict", team: { name: "同事改的名", rev: 3 } });
    expect(JSON.stringify(withCurrent)).not.toContain(SENTINEL);
    expect((await conflict({ ...t.record, teamId: "other-team" }))?.conflict).toEqual({ code: "team_conflict", team: null });
    const projectConflict = sharedProjectsApi({ fp: "synthetic" }, "demo-b", async (path, init) => {
      if (init.method !== "PATCH") return bridge(async () => ownerRead()).raw();
      throw new ApiError("x", 409, { ok: false, code: "project_conflict" }, "project_conflict");
    });
    await projectConflict.list(signal());
    await expect(projectConflict.updateTeam!(scope, { rev: 1, name: "x" }, signal()))
      .rejects.toMatchObject({ status: 409, conflict: { code: "project_conflict", team: null } });
    const member = bridge(async () => t.responses.team);
    const port = sharedProjectsApi({ fp: "synthetic" }, p.project.projectId, member.request);
    await port.list(signal());
    await expect(port.updateTeam!(scope, { rev: 1, name: "x" }, signal())).rejects.toMatchObject({ status: 403 });
    expect(member.sent.map(s => s.path)).toEqual(["/shared-projects/snapshot"]);
  });
});
