import { describe, expect, test } from "bun:test";
import { boundProjects, eligibleLocals, ProjectFailure, projectErrorText, projectKey } from "../web/lib/shared-projects-model";
import { parseProjectMembers, parseProjectSnapshot, parseSharedProject } from "../web/lib/shared-projects-parse";
import { projectChoice, projectChoiceWire } from "../web/lib/shared-projects-choice";

const project = () => ({ centerId: "center-a", teamId: "team-a", projectId: "app", name: "中心显示名", rev: 3,
  status: "active", role: "owner", availability: "ready", local: { id: "different-local", name: "本机名称", dirs: ["/synthetic/app"] } });
const snapshot = () => ({
  teams: [{ centerId: "center-a", teamId: "team-a", name: "示例团队", personId: "person-a", teamRole: "owner" }],
  projects: [project()],
  localProjects: [{ id: "personal", name: "个人", personal: true, bound: false },
    { id: "bound", name: "已绑定", personal: false, bound: true }, { id: "eligible", name: "可绑定", personal: false, bound: false }],
  peers: [{ id: "synthetic-peer", name: "协作伙伴" }],
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
    const value = { personId: "person-b", code: "伙伴", role: "member", status: "invited" };
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
