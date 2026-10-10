import { describe, expect, test } from "bun:test";
import { boundProjects, eligibleLocals, ProjectFailure, projectErrorText, projectKey } from "../web/lib/shared-projects-model";
import { parseProjectMembers, parseProjectSnapshot, parseSharedProject } from "../web/lib/shared-projects-parse";
import { projectChoice, projectChoiceWire } from "../web/lib/shared-projects-choice";
import { projectSourceCards, projectSourceSnapshot } from "../web/lib/shared-projects-source";
import { sharedProjectsApi, type ProjectRequest } from "../web/lib/shared-projects-api";
import { sharedProjectsByBindings } from "../web/lib/shared-projects-bindings";
import { ApiError } from "../web/lib/api/client";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures";
import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects";
import type { SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports";

const project = () => ({ centerId: "center-a", teamId: "team-a", projectId: "app", name: "中心显示名", rev: 3,
  status: "active", role: "owner", availability: "ready", local: { id: "different-local", name: "本机名称", dirs: ["/synthetic/app"] } });
const snapshot = () => ({
  teams: [{ centerId: "center-a", teamId: "team-a", name: "示例团队", personId: "person-a", teamRole: "owner" }],
  projects: [project()],
  localProjects: [{ id: "personal", name: "个人", personal: true, bound: false },
    { id: "bound", name: "已绑定", personal: false, bound: true }, { id: "eligible", name: "可绑定", personal: false, bound: false }],
  peers: [{ id: "synthetic-peer", name: "协作伙伴" }],
});

async function n4Source() {
  const f = createV2ProjectsFixtures();
  const local = { projects: [{ id: "different-local", name: "本机名称", dirs: ["/synthetic/app"], personal: false }],
    peers: [{ name: "transport-only", enabled: true, invitable: true }] };
  const d = { person: async () => ({ ...f.person, subject: "owner:self", ...f.requests.list }), list: async () => [f.project],
    members: async () => [f.member, f.responses.invite.member], bindings: () => [{ ...f.identity, localProjectId: "different-local" }] } as unknown as SharedProjectsPorts;
  return { f, d, local, raw: await sharedProjectsSnapshot(d, local) };
}

describe("N4 source consumption (synthetic canonical records, actual route)", () => {
  test("actual producer roles/binding/dirs/capabilities project safely and unknown teamRole cannot create", async () => {
    const { f, raw } = await n4Source();
    const next = projectSourceSnapshot(raw);
    expect(next.teams[0]?.teamRole).toBeNull();
    expect(next.projects[0]).toMatchObject({ ...f.identity, name: f.project.name, role: "owner",
      local: { id: "different-local", name: "本机名称", dirs: ["/synthetic/app"] }, personId: f.person.personId });
    expect(boundProjects(next)).toHaveLength(1);
    expect(next.capabilities).toEqual({ invite: true, leave: false });
    expect(JSON.stringify(next)).not.toContain("sourceBinding");
    const dangling = projectSourceSnapshot({ ...raw, projects: [raw.projects[0],
      { ...raw.projects[0], projectId: "dangling", localProjectIds: ["missing"] }] });
    expect(dangling.projects[1]).toMatchObject({ local: null, availability: "pending" });
    expect(boundProjects(dangling).map(p => p.projectId)).toEqual([f.project.projectId]);
    expect(dangling.teams[0]?.team).toBeNull();
    expect(dangling.teams[0]?.directory).toBeNull();
    expect(dangling.teams[0]).not.toHaveProperty("name");
    expect(() => projectSourceSnapshot({ ...raw, projects: [{ ...raw.projects[0], teamId: "other" }] })).toThrow(ProjectFailure);
    const unavailable = projectSourceSnapshot({ ...raw, projects: [{ ...raw.projects[0], projectRole: { available: false, reason: "missing" } }] });
    expect(unavailable.projects[0]?.role).toBeNull();
    expect(boundProjects(unavailable)).toEqual([]);
  });
  test("adapter consumes actual N4 snapshot/member route and emits exact recipient/local bodies", async () => {
    const { f, d, local } = await n4Source();
    const calls: { path: string; body: unknown; header: string | null }[] = [];
    d.invite = async (_who, _id, peers, note, recipient) => {
      expect(peers).toEqual(["transport-only"]); expect(note).toBe("note"); expect(recipient).toEqual({ personId: f.responses.invite.member.personId });
      return { askId: "actual-card-id" };
    };
    d.setDirs = async (_who, _id, id, dirs) => { expect(id).toBe("different-local"); expect(dirs).toEqual(["/synthetic/new"]); };
    const request: ProjectRequest = async (path, init) => {
      const url = new URL(`http://fixture/api/v1${path}`), req = new Request(url.toString(), { method: init.method, headers: init.headers,
        ...(init.json ? { body: JSON.stringify(init.json) } : {}) });
      calls.push({ path, body: init.json, header: req.headers.get("x-shared-ledger-project") });
      const response = await handleSharedProjectsApi(req, url, { auth: async () => ({ id: "owner:self", role: "owner", manage: true, agents: ["*"], createdAt: "" }),
        ports: d, localSnapshot: async () => local });
      const body = await response!.json();
      if (!response!.ok) throw new ApiError("synthetic-sensitive-sentinel", response!.status, body as Record<string, unknown>);
      return body;
    };
    const port = sharedProjectsApi({ fp: "synthetic-machine" }, f.project.projectId, request), signal = new AbortController().signal;
    const next = await port.list(signal), p = next.projects[0]!;
    expect(await port.members(p, signal)).toHaveLength(2);
    await port.invite(p, { peers: ["transport-only"], note: "note", recipient: { personId: f.responses.invite.member.personId } }, signal);
    await port.directories(p, ["/synthetic/new"], signal);
    expect(calls.every(c => c.header === f.project.projectId)).toBe(true);
    await expect(port.leave(p, signal)).rejects.toMatchObject({ status: 501 });
    await expect(port.create({ ...f.requests.list, name: "No inferred team owner", operationId: "op" }, signal)).rejects.toMatchObject({ status: 403 });
    await expect(port.members({ ...p, teamId: "body-cannot-select-scope" }, signal)).rejects.toMatchObject({ status: 403 });
    expect(calls.filter(c => c.path.endsWith("/leave"))).toHaveLength(0);
  });
  test("real card surface excludes binds/bodies, obeys owner permission/expiry and supplies explicit wires", () => {
    const card = { id: "card", project: "master", state: "open", source: "system", kind: "authorize", canAnswer: true, expiresAt: 200,
      createdBy: "system:shared-ledger-join-offer", title: "加入合成项目", context: "中心核验的项目\n原批准信息", body: "synthetic-sensitive-sentinel",
      bind: { params: { code: "synthetic-sensitive-sentinel" } },
      extra: { sharedProjectChoice: { selectId: "shared_project_local", recommended: "create" } },
      options: [{ type: "select", id: "shared_project_local", options: [{ value: "create", label: "新建本机项目" }] },
        { type: "buttons", buttons: [{ id: "sl_join_accept", label: "加入" }, { id: "sl_join_decline", label: "不加入" }] }] };
    const projected = projectSourceCards({ asks: [card] }, 100);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.choice?.recommended).toBe("create");
    expect(JSON.stringify(projected)).not.toContain("synthetic-sensitive-sentinel");
    expect(projectSourceCards({ asks: [card] }, 200)).toEqual([]);
    expect(projectSourceCards({ asks: [{ ...card, canAnswer: undefined }] }, 100)[0]?.canAnswer).toBe(false);
    expect(projectSourceCards({ asks: [{ ...card, createdBy: "agent:guess" }] }, 100)).toEqual([]);
    expect(projectSourceCards({ asks: [{ ...card, options: [{ ...card.options[0], id: "changed" }, card.options[1]] }] }, 100)).toEqual([]);
  });
  test("CAS current is scoped and secret-free; answered recovery alone never implies completion", async () => {
    const { f, raw } = await n4Source();
    const sent: { path: string; json: unknown }[] = [];
    const port = sharedProjectsApi({ fp: "synthetic-machine" }, f.project.projectId, async (path, init) => {
      sent.push({ path, json: init.json });
      if (path.endsWith("/snapshot")) return { ...raw, teamRole: { available: true, value: "owner" } };
      if (init.method === "PATCH") throw new ApiError("synthetic-sensitive-sentinel", 409,
        { current: { ...f.project, name: "新版中心名称", rev: 4, bearer: "synthetic-sensitive-sentinel" } });
      if (path === "/shared-projects") return { ok: true, operationId: "same-operation", available: false, askId: "recovery" };
      if (path === "/asks/recovery") return { ask: { state: "answered", extra: { sharedProjectExecuted: true } } };
      return { ok: true };
    });
    const signal = new AbortController().signal, next = await port.list(signal), p = next.projects[0]!;
    let failure: ProjectFailure | undefined;
    try { await port.patch(p, { rev: 1, name: "计划名称" }, signal); } catch (e) { failure = e as ProjectFailure; }
    expect(failure?.current).toMatchObject({ name: "新版中心名称", rev: 4, local: { id: "different-local" }, role: "owner" });
    expect(JSON.stringify(failure)).not.toContain("synthetic-sensitive-sentinel");
    const input = { ...f.requests.list, name: f.project.name, operationId: "same-operation", localProjectId: "different-local" };
    await expect(port.create(input, signal)).rejects.toMatchObject({ status: 202 });
    expect(sent.find(c => c.path === "/shared-projects")?.json).toEqual({ name: f.project.name, operationId: "same-operation",
      selection: { mode: "existing", localProjectId: "different-local" } });
    await expect(port.complete(input, signal)).rejects.toMatchObject({ status: 202 });
    expect(sent.some(c => c.path.endsWith("/continue"))).toBe(false);
    expect(sent.filter(c => c.path === "/shared-projects")).toHaveLength(1);
    await port.answer!({ id: "actual-card", project: "master", title: "确认", context: "实际卡片", expiresAt: Date.now() + 10000,
      canAnswer: true, choice: null, accept: { id: "shared_project_confirm", label: "确认" }, decline: { id: "shared_project_cancel", label: "取消" } },
    ["[button:shared_project_confirm]"], signal);
    expect(sent.at(-1)).toEqual({ path: "/ledger/master/asks/actual-card/answer", json: { choices: ["[button:shared_project_confirm]"] } });
  });
});

describe("shared project presentation boundary", () => {
  test("sidebar uses explicit binding and center display name even when local id differs", () => {
    const next = parseProjectSnapshot(snapshot());
    expect(boundProjects(next).map(p => p.name)).toEqual(["中心显示名"]);
    expect(eligibleLocals(next).map(p => p.id)).toEqual(["eligible"]);
    next.projects.push({ ...next.projects[0]!, projectId: "other", local: null });
    next.projects.push({ ...next.projects[0]!, projectId: "pending", availability: "pending" });
    expect(boundProjects(next)).toHaveLength(1);
  });
  test("identity is center/team/project, never the name", () => {
    const p = parseSharedProject(project());
    expect(projectKey(p)).not.toBe(projectKey({ ...p, centerId: "other-center" }));
    expect(projectKey(p)).toBe(projectKey({ ...p }));
  });
  test("response extras cannot enter the presentation model", () => {
    const secret = "synthetic-sensitive-sentinel";
    const raw = snapshot();
    const next = parseProjectSnapshot({ ...raw, bearer: secret, error: secret,
      projects: [{ ...raw.projects[0], joinCode: secret, bearer: secret, local: { ...raw.projects[0]!.local, token: secret } }],
      peers: [{ ...raw.peers[0], token: secret }] });
    expect(JSON.stringify(next)).not.toContain(secret);
  });
  test("roles are explicit; missing, service or malformed roles never imply owner", () => {
    for (const role of [undefined, "service", true]) expect(() => parseSharedProject({ ...project(), role })).toThrow(ProjectFailure);
    expect(() => parseProjectSnapshot({ ...snapshot(), teams: [{ ...snapshot().teams[0], teamRole: "service" }] })).toThrow(ProjectFailure);
  });
  test("ambiguous local and remote bindings are rejected", () => {
    expect(() => parseProjectSnapshot({ ...snapshot(), projects: [project(), project()] })).toThrow(ProjectFailure);
    expect(() => parseProjectSnapshot({ ...snapshot(), projects: [project(), { ...project(), projectId: "second" }] })).toThrow(ProjectFailure);
    expect(() => parseProjectSnapshot({ ...snapshot(), projects: [{ ...project(), teamId: "wrong-team" }] })).toThrow(ProjectFailure);
  });
  test("malformed revisions, ids and statuses fail closed", () => {
    for (const rev of [-1, 0, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseSharedProject({ ...project(), rev })).toThrow(ProjectFailure);
    }
    for (const projectId of ["../app", "a/b", "", "x".repeat(33)]) {
      expect(() => parseSharedProject({ ...project(), projectId })).toThrow(ProjectFailure);
    }
    expect(() => parseSharedProject({ ...project(), status: "deleted" })).toThrow(ProjectFailure);
  });
  test("member DTO only exposes display fields with validated states", () => {
    const value = { personId: "person-b", code: "伙伴", role: "member", status: "invited" } as const;
    expect(parseProjectMembers([{ ...value, bearer: "synthetic-token" }])).toEqual([value]);
    expect(() => parseProjectMembers([{ ...value, role: "service" }])).toThrow(ProjectFailure);
  });
  test("errors contain fixed text only", () => {
    for (const status of [0, 400, 401, 403, 404, 409, 500, 501, 502]) {
      expect(new ProjectFailure(status).message).toBe(projectErrorText(status));
      expect(projectErrorText(status)).not.toContain("synthetic-token");
    }
  });
  test("join recommendation selects only an existing option; wire requires explicit selection", () => {
    const extra = { sharedProjectChoice: { selectId: "binding", recommended: "create" } };
    const rows = [{ type: "select", id: "binding", options: [{ value: "create", label: "新建" }] }];
    const choice = projectChoice(extra, rows)!;
    expect(choice.recommended).toBe("create");
    expect(projectChoiceWire(choice, "")).toBeNull();
    expect(projectChoiceWire(choice, "create")).toBe("[select:binding:create]");
    expect(projectChoice({ sharedProjectChoice: { selectId: "binding", recommended: "unknown" } }, rows)?.recommended).toBe("");
    expect(projectChoice(extra, null)).toBeNull();
    expect(projectChoice(extra, [{ ...rows[0], options: [{ value: "bad]wire", label: "bad" }] }])).toBeNull();
  });
});


describe("multiple original binding sources", () => {
  const signal = () => new AbortController().signal;
  test("two same-team bindings are read explicitly and merge center names, without duplicate projects", async () => {
    const { raw } = await n4Source();
    const calls: { path: string; source?: string }[] = [];
    const hints = [raw.projects[0]!.projectId, "new-project"].map(project => ({ center: raw.identity.centerId,
      team: raw.identity.teamId, person: raw.identity.personId, homeInstanceId: raw.identity.instanceId, project }));
    const port = sharedProjectsByBindings({ fp: "synthetic" }, async (path, init) => {
      calls.push({ path, source: init.headers?.["x-shared-ledger-project"] });
      if (path === "/shared-ledger/context") return { identities: hints };
      return { ...raw, projects: [raw.projects[0], { ...raw.projects[0], projectId: "new-project", name: "新项目核验名", localProjectIds: [] }] };
    });
    const next = await port.list(signal());
    expect(next.projects.map(p => p.name)).toEqual([raw.projects[0]!.name, "新项目核验名"]);
    expect(next.teams).toHaveLength(1);
    expect(calls.filter(c => c.path.endsWith("/snapshot")).map(c => c.source)).toEqual(hints.map(h => h.project));
    expect(next.sourceWarnings).toEqual([]);
  });
  test("cross-team equal projectIds cannot select any ambiguous header and give the N4 dependency", async () => {
    const { raw } = await n4Source();
    const calls: string[] = [];
    const port = sharedProjectsByBindings({ fp: "synthetic" }, async path => {
      calls.push(path);
      return { identities: ["team-a", "team-b"].map(team => ({ center: "center", team, person: "person", homeInstanceId: "instance",
        project: raw.projects[0]!.projectId })) };
    });
    const next = await port.list(signal());
    expect(next.projects).toEqual([]);
    expect(next.sourceWarnings?.[0]).toContain("需要 N4 选择头带 center/team");
    expect(calls).toEqual(["/shared-ledger/context"]);
    await expect(port.members({ centerId: "center", teamId: "team-a", projectId: "demo-b" }, signal())).rejects.toMatchObject({ status: 403 });
  });
  test("distinct center/team scopes with equal display names stay distinct and route to their own source", async () => {
    const { raw } = await n4Source();
    const first = raw, second = { ...raw, identity: { ...raw.identity, centerId: "other-center", teamId: "other-team" },
      projects: [{ ...raw.projects[0], centerId: "other-center", teamId: "other-team", projectId: "other-project", localProjectIds: [] }] };
    const inputs = [first, second], calls: string[] = [];
    const port = sharedProjectsByBindings({ fp: "synthetic" }, async (path, init) => {
      if (path === "/shared-ledger/context") return { identities: inputs.map(r => ({ center: r.identity.centerId, team: r.identity.teamId,
        person: r.identity.personId, homeInstanceId: r.identity.instanceId, project: r.projects[0]!.projectId })) };
      const source = init.headers?.["x-shared-ledger-project"];
      if (init.method === "PATCH") { calls.push(source!); return { ok: true }; }
      return inputs.find(r => r.projects[0]!.projectId === source)!;
    });
    const next = await port.list(signal());
    expect(next.teams).toHaveLength(2);
    expect(next.projects.map(p => p.name)).toEqual([raw.projects[0]!.name, raw.projects[0]!.name]);
    expect(new Set(next.projects.map(projectKey)).size).toBe(2);
    expect(next.teams.map(t => t.team)).toEqual([null, null]);
    expect(next.teams[0]?.teamId).not.toBe(next.teams[1]?.teamId);
    await port.patch(next.projects[1]!, { rev: 1, name: "同名仍按绑定" }, signal());
    expect(calls).toEqual(["other-project"]);
  });
  test("no binding sends no snapshot, and snapshot/context scope mismatches fail closed", async () => {
    const { raw } = await n4Source();
    const calls: string[] = [];
    const empty = sharedProjectsByBindings({ fp: "synthetic" }, async path => { calls.push(path); return { identities: [] }; });
    await expect(empty.list(signal())).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual(["/shared-ledger/context"]);
    const wrong = sharedProjectsByBindings({ fp: "synthetic" }, async path => path === "/shared-ledger/context"
      ? { identities: [{ center: raw.identity.centerId, team: "wrong-team", person: raw.identity.personId,
        homeInstanceId: raw.identity.instanceId, project: raw.projects[0]!.projectId }] } : raw);
    await expect(wrong.list(signal())).rejects.toMatchObject({ status: 502 });
  });
  test("conflicting same-team persons disable only that team's sources, independent of hint order", async () => {
    const { raw } = await n4Source();
    const healthy = { ...raw, identity: { ...raw.identity, centerId: "other-center", teamId: "other-team" },
      projects: [{ ...raw.projects[0], centerId: "other-center", teamId: "other-team", projectId: "healthy", localProjectIds: ["different-local"] }] };
    const stale = { ...raw, identity: { ...raw.identity, personId: "old-person" },
      projects: [{ ...raw.projects[0], projectId: "old-binding", localProjectIds: [] }] };
    for (const reverse of [false, true]) {
      const hints = [raw, stale, healthy].map(r => ({ center: r.identity.centerId,
        team: r.identity.teamId, person: r.identity.personId, homeInstanceId: r.identity.instanceId, project: r.projects[0]!.projectId }));
      if (reverse) hints.reverse();
      const calls: string[] = [];
      let conflicted = true;
      const port = sharedProjectsByBindings({ fp: "synthetic" }, async (path, init) => {
        if (path === "/shared-ledger/context") return { identities: conflicted ? hints : hints.filter(h => h.person !== "old-person") };
        calls.push(init.headers?.["x-shared-ledger-project"] ?? "UNSELECTED");
        if (path.endsWith("/snapshot")) return init.headers?.["x-shared-ledger-project"] === "healthy" ? healthy
          : init.headers?.["x-shared-ledger-project"] === "old-binding" ? stale : raw;
        return { ok: true };
      });
      conflicted = false;
      expect(boundProjects(await port.list(signal()))).toHaveLength(2);
      conflicted = true; calls.length = 0;
      const next = await port.list(signal());
      expect(boundProjects(next).map(p => p.projectId)).toEqual(["healthy"]);
      expect(next.teams).toHaveLength(1);
      expect(next.sourceWarnings?.[0]).toContain("团队身份冲突");
      expect(calls).toEqual(["healthy"]);
      await expect(port.patch(raw.projects[0]!, { rev: 1, name: "blocked" }, signal())).rejects.toMatchObject({ status: 403 });
      await port.patch(next.projects[0]!, { rev: 1, name: "still available" }, signal());
      expect(calls.at(-1)).toBe("healthy");
      conflicted = false;
      expect(boundProjects(await port.list(signal()))).toHaveLength(2);
    }
  });
  test("transient source failure preserves verified projects, revocation removes them", async () => {
    const { raw } = await n4Source();
    let status = 0;
    const port = sharedProjectsByBindings({ fp: "synthetic" }, async path => {
      if (path === "/shared-ledger/context") return { identities: [{ center: raw.identity.centerId, team: raw.identity.teamId,
        person: raw.identity.personId, homeInstanceId: raw.identity.instanceId, project: raw.projects[0]!.projectId }] };
      if (status) throw new ApiError("synthetic-sensitive-sentinel", status);
      return raw;
    });
    await port.list(signal());
    status = 429;
    expect(boundProjects(await port.list(signal()))).toHaveLength(1);
    status = 403;
    await expect(port.list(signal())).rejects.toMatchObject({ status: 403 });
    await expect(port.members(raw.projects[0]!, signal())).rejects.toMatchObject({ status: 403 });
  });
});
