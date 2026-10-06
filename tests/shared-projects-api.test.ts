import { describe, expect, test } from "bun:test";
import type { Ask } from "../src/lib/ledger-asks.js";
import type { Principal } from "../src/lib/principals.js";
import { configureSharedProjects, onSharedProjectAnswered } from "../src/bridge/local-api/shared-projects-runtime.js";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects.js";
import { answerSharedProject, bootstrapSharedProject, createSharedProject, proposeSharedProject } from "../src/bridge/local-api/shared-projects-actions.js";
import { SharedProjectsError, type SharedProjectsPorts, type ProjectPerson } from "../src/bridge/local-api/shared-projects-ports.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" };
const operationId = "operation_123456789";
const person: ProjectPerson = { subject: "owner:self", kind: "person", centerId: "center-a", teamId: "team-a", personId: "alice", instanceId: "machine-a" };
const project = { centerId: "center-a", teamId: "team-a", projectId: "b", name: "Project B", status: "active" as const, rev: 1 };
function fixture() {
  const calls: string[] = [], asks: Ask[] = [];
  let saved = false;
  const d: SharedProjectsPorts = {
    now: () => Date.now(), person: async () => person, list: async () => [project],
    create: async () => { calls.push("create"); return { operationId, version: 1, project }; },
    patch: async (_who, id, b) => ({ ...project, projectId: id, ...b }),
    invite: async (_who, _id, peers) => peers.map(peer => ({ peer, offerId: "a".repeat(32), accepted: true })),
    operation: async () => { calls.push("query"); return { operationId, version: 1, project }; },
    saveCreatorCredential: async () => { calls.push("save-b"); saved = true; },
    credentialSaved: async () => { calls.push("read-b"); return saved; },
    bind: async () => { calls.push("bind-b"); return "local-b"; },
    gateRead: async () => { calls.push("gate-b"); return true; },
    members: async () => [{ personId: "alice", code: "Alice", role: "owner", status: "active" }],
    remove: async () => { calls.push("remove"); }, setDirs: async () => { calls.push("dirs"); }, leave: async () => { calls.push("leave"); },
    bindings: () => [{ centerId: "center-a", teamId: "team-a", projectId: "a", localProjectId: "local-a" }],
    eligible: async () => [{ id: "local-b", name: "Project B" }],
    openAsk: input => {
      const a = { ...input, id: `ask_${asks.length}`, state: "open", answer: null, fromAgent: null, extra: input.extra ?? {} } as Ask;
      asks.push(a); return a;
    },
    deploymentAuthorized: async () => true,
    preflight: async () => ({ ...person, operationId, instanceKeyDigest: "a".repeat(64), summaryDigest: "b".repeat(64),
      expiresAt: Date.now() + 60000, ownerCount: 0, memberActive: true }),
    confirmOwner: async () => { calls.push("confirm-owner"); },
  };
  const request = (method: string, path = "", body?: unknown, principal: Principal | Response = owner) => {
    const url = new URL(`http://fixture/api/v1/shared-projects${path}`);
    return handleSharedProjectsApi(new Request(url.toString(), { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), url,
      { auth: async () => principal, ports: d });
  };
  return { d, calls, asks, request };
}
function approve(a: Ask, changes: Partial<Ask> = {}): Ask {
  return { ...a, state: "answered", answer: { choices: ["[button:shared_project_confirm]"], labels: ["confirm"], text: "", principal: "owner:self",
    owner: true, via: "web_card", at: Date.now() }, ...changes };
}
const create = { operationId, name: "Project B", selection: { mode: "create" as const } };

describe("owner-only shared project routes", () => {
  test("guest, peer, disabled, scoped/restricted owner and missing auth cannot reach an adapter", async () => {
    const w = fixture();
    w.d.person = async () => { throw new Error("must not resolve identities"); };
    const principals: (Principal | Response)[] = [
      { ...owner, id: "guest:a" }, { ...owner, peer: "peer-a" }, { ...owner, disabled: true }, { ...owner, agents: ["a"] },
      { ...owner, manage: false }, Response.json({}, { status: 401 }),
    ];
    for (const p of principals) for (const [method, path] of [["GET", ""], ["POST", ""], ["PATCH", "/b"], ["POST", "/b/invite"], ["POST", "/owner-bootstrap"]]) {
      expect((await w.request(method!, path!, {}, p))!.status).toBe(403);
    }
    expect(w.calls).toEqual([]);
  });
  test("missing N1–N3 adapter fails closed, while unrelated routes are untouched", async () => {
    const url = new URL("http://fixture/api/v1/shared-projects");
    expect((await handleSharedProjectsApi(new Request(url.toString()), url, { auth: async () => owner }))!.status).toBe(503);
    const other = new URL("http://fixture/api/v1/other");
    expect(await handleSharedProjectsApi(new Request(other.toString()), other, { auth: async () => owner })).toBeNull();
  });
  test("list joins local binding and strips arbitrary response fields", async () => {
    const w = fixture();
    w.d.list = async () => [{ ...project, projectId: "a", bearer: "DO_NOT_SHOW" } as typeof project];
    const response = await w.request("GET");
    const body = await response!.json() as { projects: { localProjectIds: string[] }[] };
    expect(body.projects[0].localProjectIds).toEqual(["local-a"]);
    expect(JSON.stringify(body)).not.toContain("DO_NOT_SHOW");
  });
  test("request cannot choose person or service; malformed and oversized bodies are rejected", async () => {
    const w = fixture();
    for (const b of [{ ...create, personId: "bob" }, { ...create, kind: "service" }, { ...create, selection: { mode: "existing" } }]) {
      expect((await w.request("POST", "", b))!.status).toBe(400);
    }
    expect((await w.request("POST", "", { ...create, name: "x".repeat(9000) }))!.status).toBe(413);
    expect(w.calls).toEqual([]);
  });
  test("PATCH propagates CAS rejection without reflecting center errors", async () => {
    const w = fixture();
    w.d.patch = async () => { throw new SharedProjectsError(409, "SECRET_RESPONSE", { ...project, rev: 2 }); };
    const res = await w.request("PATCH", "/b", { rev: 1, name: "renamed" });
    expect(res!.status).toBe(409);
    const text = await res!.text();
    expect(text).not.toContain("SECRET_RESPONSE");
    expect(JSON.parse(text).current.rev).toBe(2);
  });
  test("service identity never reaches create/bootstrap even with local owner credentials", async () => {
    const w = fixture();
    w.d.person = async () => ({ ...person, kind: "service" } as unknown as ProjectPerson);
    expect((await w.request("POST", "", create))!.status).toBe(403);
    expect((await w.request("POST", "/owner-bootstrap", { operationId }))!.status).toBe(403);
    expect(w.calls).toEqual([]);
  });
});

describe("creator completion and recovery", () => {
  test("B only becomes available after credential persistence, readback, binding and gate read in order", async () => {
    const w = fixture();
    const oldBindings = JSON.stringify(w.d.bindings());
    const result = await createSharedProject(create, w.d);
    expect(result.available).toBe(true);
    expect(w.calls).toEqual(["create", "read-b", "save-b", "read-b", "bind-b", "gate-b"]);
    expect(JSON.stringify(w.d.bindings())).toBe(oldBindings);
  });
  test("save failure never binds, and recovery queries the same operation without another create", async () => {
    const w = fixture();
    const save = w.d.saveCreatorCredential;
    w.d.saveCreatorCredential = async () => { throw new Error("SECRET_BEARER"); };
    expect((await createSharedProject(create, w.d)).available).toBe(false);
    expect(w.calls).not.toContain("bind-b");
    expect(JSON.stringify(w.asks)).not.toContain("SECRET_BEARER");
    w.d.saveCreatorCredential = save;
    expect((await answerSharedProject(approve(w.asks[0]!), w.d))!.available).toBe(true);
    expect(w.calls.filter(c => c === "create")).toHaveLength(1);
    expect(w.calls).toContain("query");
  });
  test("lost create response and failed gate read both expose continue cards", async () => {
    const w = fixture();
    w.d.create = async () => { throw new Error("lost response"); };
    expect((await createSharedProject(create, w.d)).available).toBe(false);
    w.d.gateRead = async () => false;
    expect((await answerSharedProject(approve(w.asks[0]!), w.d))!.available).toBe(false);
    expect(w.asks).toHaveLength(2);
    expect(w.asks[1]!.title).toBe("继续完成项目");
  });
  test("create without selection persists credentials and asks before binding", async () => {
    const w = fixture();
    await createSharedProject({ operationId, name: "B" }, w.d);
    expect(w.calls).not.toContain("bind-b");
    expect(w.asks[0]!.extra.sharedProjectChoice).toEqual({ selectId: "shared_project_local", recommended: "local_local-b" });
    await expect(answerSharedProject(approve(w.asks[0]!), w.d)).rejects.toThrow();
    const a = approve(w.asks[0]!);
    a.answer!.choices.push("[select:shared_project_local:local_local-b]");
    expect((await answerSharedProject(a, w.d))!.available).toBe(true);
  });
});

describe("ask-bound create and deployment owner approval", () => {
  test("PM proposal never creates before an owner approval", async () => {
    const w = fixture();
    const a = await proposeSharedProject(create, w.d);
    expect(w.calls).toEqual([]);
    const guest = approve(a); guest.answer!.owner = undefined; guest.answer!.external = true; guest.answer!.principal = "guest:x";
    await expect(answerSharedProject(guest, w.d)).rejects.toThrow();
    expect(w.calls).toEqual([]);
    await answerSharedProject(approve(a), w.d);
    expect(w.calls[0]).toBe("create");
  });
  test("modified create params or changed verified person fail ask-check", async () => {
    const w = fixture(), a = await proposeSharedProject(create, w.d);
    const forged = structuredClone(approve(a));
    (forged.bind!.params as { input: { name: string } }).input.name = "evil";
    await expect(answerSharedProject(forged, w.d)).rejects.toThrow();
    w.d.person = async () => ({ ...person, personId: "bob" });
    await expect(answerSharedProject(approve(a), w.d)).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
  test("deployment authorization and zero owners are mandatory at preflight and execution", async () => {
    const w = fixture();
    w.d.deploymentAuthorized = async () => false;
    await expect(bootstrapSharedProject(operationId, w.d)).rejects.toThrow();
    w.d.deploymentAuthorized = async () => true;
    const preflight = w.d.preflight;
    w.d.preflight = async (...args) => ({ ...await preflight(...args), ownerCount: 1 });
    await expect(bootstrapSharedProject(operationId, w.d)).rejects.toThrow();
    w.d.preflight = preflight;
    const a = await bootstrapSharedProject(operationId, w.d);
    w.d.deploymentAuthorized = async () => false;
    await expect(answerSharedProject(approve(a), w.d)).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
  test("team, person, instance, public key and preflight digest tampering never invokes executor", async () => {
    const w = fixture(), a = await bootstrapSharedProject(operationId, w.d);
    for (const field of ["teamId", "personId", "instanceId", "instanceKeyDigest", "summaryDigest", "operationId", "expiresAt"]) {
      const altered = structuredClone(approve(a));
      (altered.bind!.params as { preflight: Record<string, unknown> }).preflight[field] = "changed";
      await expect(answerSharedProject(altered, w.d)).rejects.toThrow();
    }
    expect(w.calls).toEqual([]);
    await answerSharedProject(approve(a), w.d);
    expect(w.calls).toEqual(["confirm-owner"]);
  });
});

test("registered adapter serves the production route and receives answered project cards", async () => {
  const w = fixture(); configureSharedProjects(w.d);
  try {
    const url = new URL("http://fixture/api/v1/shared-projects");
    const response = await handleSharedProjectsApi(new Request(url.toString()), url, { auth: async () => owner });
    expect(response!.status).toBe(200);
    const ask = await proposeSharedProject(create, w.d);
    await onSharedProjectAnswered(approve(ask));
    expect(w.calls).toContain("gate-b");
  } finally { configureSharedProjects(undefined); }
});

test("members, remove, dirs and leave delegate only after explicit binding checks", async () => {
  const w = fixture();
  expect((await w.request("GET", "/a/members"))!.status).toBe(200);
  expect((await w.request("POST", "/a/members/alice/remove", {}))!.status).toBe(200);
  expect((await w.request("PATCH", "/a/dirs", { localProjectId: "local-a", dirs: ["/synthetic/project"] }))!.status).toBe(200);
  expect((await w.request("POST", "/a/leave", { localProjectId: "local-a" }))!.status).toBe(200);
  expect(w.calls).toEqual(["remove", "dirs", "leave"]);
  expect((await w.request("POST", "/b/leave", { localProjectId: "local-a" }))!.status).toBe(409);
  expect((await w.request("PATCH", "/a/dirs", { localProjectId: "local-a", dirs: ["relative"] }))!.status).toBe(400);
  expect(w.calls).toEqual(["remove", "dirs", "leave"]);
});

test("HTTP continue queries the existing creator operation and never creates again", async () => {
  const w = fixture();
  const response = await w.request("POST", `/operations/${operationId}/continue`, { selection: { mode: "create" } });
  expect(response!.status).toBe(200);
  expect(w.calls[0]).toBe("query");
  expect(w.calls).not.toContain("create");
});

test("retry after a successful bind and failed gate read reuses B's binding", async () => {
  const w = fixture(); let bound = false;
  const bindings = w.d.bindings;
  w.d.bindings = () => [...bindings(), ...(bound ? [{ centerId: person.centerId, teamId: person.teamId, projectId: "b", localProjectId: "local-b" }] : [])];
  w.d.bind = async () => { w.calls.push("bind-b"); bound = true; return "local-b"; };
  w.d.gateRead = async () => false;
  expect((await createSharedProject(create, w.d)).available).toBe(false);
  w.d.gateRead = async () => true;
  expect((await answerSharedProject(approve(w.asks[0]!), w.d))!.available).toBe(true);
  expect(w.calls.filter(c => c === "bind-b")).toHaveLength(1);
});
