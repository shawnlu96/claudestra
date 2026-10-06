import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot.js";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
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
const canonical = createV2ProjectsFixtures();
const project = { ...canonical.project, centerId: person.centerId, teamId: person.teamId, projectId: "b", name: "Project B", createdBy: person.personId };
const operation = { ...canonical.operation, centerId: project.centerId, teamId: project.teamId, projectId: project.projectId, operationId, personId: person.personId, instanceId: person.instanceId };
function fixture() {
  const calls: string[] = [], asks: Ask[] = [];
  let saved = false;
  const claimed = new Set<string>();
  const d: SharedProjectsPorts = {
    now: () => Date.now(), person: async () => person, list: async () => [project],
    create: async () => { calls.push("create"); return { operation, project }; },
    patch: async (_who, id, b) => ({ ...project, projectId: id, ...b }),
    invite: async () => ({ askId: "synthetic-invite" }), sendInvite: async () => [],
    authorizeAnswer: async () => true,
    operation: async () => { calls.push("query"); return { operation, project }; },
    enrollCreator: async () => { calls.push("save-b", "bind-b"); saved = true; return "local-b"; },
    credentialSaved: async () => { calls.push("read-b"); return saved; },
    gateRead: async () => { calls.push("gate-b"); return true; },
    members: async (_who, projectId) => [{ ...canonical.member, centerId: person.centerId, teamId: person.teamId, projectId, personId: "alice", code: "Alice", role: "owner", status: "active" }],
    remove: async () => { calls.push("remove"); }, setDirs: async () => { calls.push("dirs"); }, leave: async () => { calls.push("leave"); },
    bindings: () => [{ centerId: "center-a", teamId: "team-a", projectId: "a", localProjectId: "local-a" }],
    eligible: async () => [{ id: "local-b", name: "Project B" }],
    openAsk: input => {
      const a = { ...input, id: `ask_${asks.length}`, state: "open", answer: null, fromAgent: null, extra: input.extra ?? {} } as Ask;
      asks.push(a); return a;
    },
    getAsk: id => asks.find(a => a.id === id) ?? null,
    claimAsk: a => { if (claimed.has(a.id)) return false; claimed.add(a.id); return true; },
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
  return Object.assign(a, { state: "answered" as const, answer: { choices: ["[button:shared_project_confirm]"], labels: ["confirm"], text: "", principal: "owner:self",
    owner: true, via: "web_card" as const, at: Date.now() }, ...changes });
}
const create = { operationId, name: "Project B", selection: { mode: "create" as const } };

describe("owner-only shared project routes", () => {
  test("guest, peer, disabled, scoped/restricted owner and missing auth cannot reach an adapter", async () => {
    const w = fixture();
    w.d.person = async () => { throw new Error("must not resolve identities"); };
    const principals: (Principal | Response)[] = [
      { ...owner, id: "guest:a" }, { ...owner, peer: "peer-a" }, { ...owner, disabled: true }, { ...owner, agents: ["a"] },
      { ...owner, manage: false }, { ...owner, role: "external" }, { ...owner, id: "token:old", name: "web-ui" }, Response.json({}, { status: 401 }),
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
  test("list joins local binding and rejects unknown canonical response fields", async () => {
    const w = fixture();
    w.d.list = async () => [{ ...project, projectId: "a" }];
    const response = await w.request("GET");
    const body = await response!.json() as { projects: { localProjectIds: string[] }[] };
    expect(body.projects[0].localProjectIds).toEqual(["local-a"]);
    w.d.list = async () => [{ ...project, projectId: "a", bearer: "DO_NOT_SHOW" } as typeof project];
    const malformed = await w.request("GET");
    expect(malformed!.status).toBe(503);
    expect(await malformed!.text()).not.toContain("DO_NOT_SHOW");
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
    expect(w.calls).toEqual(["create", "save-b", "bind-b", "read-b", "gate-b"]);
    expect(JSON.stringify(w.d.bindings())).toBe(oldBindings);
  });
  test("save failure never binds, and recovery queries the same operation without another create", async () => {
    const w = fixture();
    const save = w.d.enrollCreator;
    w.d.enrollCreator = async () => { throw new Error("SECRET_BEARER"); };
    expect((await createSharedProject(create, w.d)).available).toBe(false);
    expect(w.calls).not.toContain("bind-b");
    expect(JSON.stringify(w.asks)).not.toContain("SECRET_BEARER");
    w.d.enrollCreator = save;
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
  test("create without selection asks before redemption, persistence or binding", async () => {
    const w = fixture();
    await createSharedProject({ operationId, name: "Project B" }, w.d);
    expect(w.calls).toEqual(["create"]);
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
  w.d.enrollCreator = async () => { throw new Error("synthetic persistence failure"); };
  await createSharedProject(create, w.d);
  const a = approve(w.asks[0]!); w.asks[0] = a; w.calls.length = 0;
  const response = await w.request("POST", `/operations/${operationId}/continue`, { askId: a.id });
  expect(response!.status).toBe(200);
  expect(w.calls[0]).toBe("query");
  expect(w.calls).not.toContain("create");
});

test("retry after a successful bind and failed gate read reuses B's binding", async () => {
  const w = fixture(); let bound = false;
  const bindings = w.d.bindings;
  w.d.bindings = () => [...bindings(), ...(bound ? [{ centerId: person.centerId, teamId: person.teamId, projectId: "b", localProjectId: "local-b" }] : [])];
  const enroll = w.d.enrollCreator;
  w.d.enrollCreator = async (...args) => { const id = await enroll(...args); bound = true; return id; };
  w.d.gateRead = async () => false;
  expect((await createSharedProject(create, w.d)).available).toBe(false);
  w.d.gateRead = async () => true;
  expect((await answerSharedProject(approve(w.asks[0]!), w.d))!.available).toBe(true);
  expect(w.calls.filter(c => c === "bind-b")).toHaveLength(1);
});


test("continue cannot replace selection, consume an unapproved card or replay an executed approval", async () => {
  const w = fixture();
  w.d.gateRead = async () => false;
  await createSharedProject(create, w.d);
  const a = w.asks[0]!;
  expect((await w.request("POST", `/operations/${operationId}/continue`, { selection: { mode: "existing", localProjectId: "local-a" } }))!.status).toBe(400);
  expect((await w.request("POST", `/operations/${operationId}/continue`, { askId: a.id }))!.status).toBe(403);
  const approved = approve(a);
  await answerSharedProject(approved, w.d);
  const before = [...w.calls];
  await expect(answerSharedProject(approved, w.d)).rejects.toThrow();
  expect(w.calls).toEqual(before);
});

test("foreign person/instance or revoked creator operation cannot save or bind", async () => {
  for (const mutation of [{ personId: "other" }, { instanceId: "other" }, { state: "revoked" as const }]) {
    const w = fixture();
    w.d.create = async () => ({ project, operation: { ...operation, ...mutation } });
    expect((await createSharedProject(create, w.d)).available).toBe(false);
    expect(w.calls).toEqual([]);
  }
});

test("bootstrap rechecks current owners and approved digests before invoking the executor", async () => {
  for (const mutation of [{ ownerCount: 1 }, { summaryDigest: "c".repeat(64) }, { instanceKeyDigest: "c".repeat(64) }]) {
    const w = fixture(); const a = await bootstrapSharedProject(operationId, w.d), preflight = w.d.preflight;
    w.d.preflight = async (...args) => ({ ...await preflight(...args), ...mutation });
    await expect(answerSharedProject(approve(a), w.d)).rejects.toThrow();
    expect(w.calls).toEqual([]);
  }
});

test("N5 snapshot reads canonical members and actual local state; team authority remains explicitly unavailable", async () => {
  const w = fixture();
  const local = { projects: [{ id: "local-a", name: "A", dirs: ["/synthetic/a"], personal: false },
    { id: "local-b", name: "B", dirs: [], personal: false }, { id: "personal", name: "Mine", dirs: [], personal: true }],
    peers: [{ name: "synthetic-peer", enabled: true, invitable: true, outToken: "DO_NOT_SHOW" }] };
  const snapshot = await sharedProjectsSnapshot(w.d, local);
  expect(snapshot.identity).toEqual(person);
  expect(snapshot.teamRole).toEqual({ available: false, reason: "center_team_role_read_contract_unavailable" });
  expect(snapshot.projects[0]!.projectRole).toEqual({ available: true, value: "owner" });
  expect(snapshot.localProjects.map(p => p.eligible)).toEqual([false, true, false]);
  expect(snapshot.localProjects[0]!.dirs).toEqual(["/synthetic/a"]);
  expect(JSON.stringify(snapshot)).not.toContain("DO_NOT_SHOW");
  w.d.members = async () => { throw new Error("SECRET_RESPONSE"); };
  const failed = await sharedProjectsSnapshot(w.d, local);
  expect(failed.projects[0]!.projectRole.available).toBe(false);
  expect(JSON.stringify(failed)).not.toContain("SECRET_RESPONSE");
});


test("recovery preserves original creation parameters, local selection and canonical operation digest", async () => {
  const w = fixture(); w.d.gateRead = async () => false;
  await createSharedProject(create, w.d);
  const a = w.asks[0]!;
  expect(a.context).toContain("Project B");
  expect(a.context).toContain("新建本机项目");
  const params = a.bind!.params as { input: unknown; selection: unknown; expectedDigest: unknown };
  expect(params.input).toEqual(create); expect(params.selection).toEqual(create.selection);
  expect(params.expectedDigest).toBe(operation.paramsDigest);
  w.calls.length = 0;
  w.d.operation = async () => ({ project, operation: { ...operation, paramsDigest: "c".repeat(64) } });
  expect((await answerSharedProject(approve(a), w.d))!.available).toBe(false);
  expect(w.calls).toEqual([]);
});


test("project adapter factory receives actual authenticated principal only after the full owner gate", async () => {
  const w = fixture(), url = new URL("http://fixture/api/v1/shared-projects");
  const seen: Principal[] = [];
  const ports = async (principal: Principal) => { seen.push(principal); return w.d; };
  const guest: Principal = { ...owner, id: "guest:test" };
  expect((await handleSharedProjectsApi(new Request(url.toString()), url, { auth: async () => guest, ports }))!.status).toBe(403);
  expect(seen).toEqual([]);
  expect((await handleSharedProjectsApi(new Request(url.toString()), url, { auth: async () => owner, ports }))!.status).toBe(200);
  expect(seen).toEqual([owner]);
});


test("adapter resolution failures never echo credential or transport data", async () => {
  const url = new URL("http://fixture/api/v1/shared-projects");
  const response = await handleSharedProjectsApi(new Request(url.toString()), url, { auth: async () => owner,
    ports: async () => { throw new Error("SECRET_CREDENTIAL"); } });
  expect(response!.status).toBe(503);
  expect(await response!.text()).not.toContain("SECRET_CREDENTIAL");
});

test("recovery binds the completed local target and refuses a later replacement without another enrollment", async () => {
  const w = fixture(); w.d.gateRead = async () => false;
  await createSharedProject(create, w.d);
  const a = w.asks[0]!;
  expect((a.bind!.params as { completedLocalProjectId?: string }).completedLocalProjectId).toBe("local-b");
  w.d.bindings = () => [{ centerId: person.centerId, teamId: person.teamId, projectId: project.projectId, localProjectId: "changed-target" }];
  w.calls.length = 0;
  expect((await answerSharedProject(approve(a), w.d))!.available).toBe(false);
  expect(w.calls).toEqual(["query"]);
});

test("changed approval title, identity context or option labels fail before project creation", async () => {
  for (const field of ["title", "context", "options"] as const) {
    const w = fixture(), a = approve(await proposeSharedProject(create, w.d));
    if (field === "options") a.options = [{ type: "buttons", buttons: [{ id: "shared_project_confirm", label: "different team", style: "success" }] }];
    else a[field] = "different team, person, instance or digest";
    await expect(answerSharedProject(a, w.d)).rejects.toThrow();
    expect(w.calls).toEqual([]);
  }
});


test("explicit recipient reaches invite adapter and invalid union shapes never do", async () => {
  const w = fixture(), seen: unknown[] = [];
  w.d.invite = async (...args) => { seen.push(args); return { askId: "synthetic-invite" }; };
  for (const recipient of [{ personId: "alice" }, { code: "NewPerson" }]) {
    expect((await w.request("POST", "/b/invite", { peers: ["transport"], note: "welcome", recipient }))!.status).toBe(202);
    expect(seen.at(-1)).toEqual([person, "b", ["transport"], "welcome", recipient]);
  }
  for (const recipient of [undefined, {}, { personId: "" }, { personId: "alice", code: "Alice" },
    { code: "NewPerson", caller: "owner:self" }]) {
    expect((await w.request("POST", "/b/invite", { peers: ["transport"], recipient }))!.status).toBe(400);
  }
  expect(seen).toHaveLength(2);
});

test("lost request before center commit retries the original idempotent create on continue", async () => {
  const w = fixture(), original = w.d.create, attempts: unknown[] = [];
  w.d.create = async (...args) => {
    attempts.push(args[1]);
    if (attempts.length === 1) throw new SharedProjectsError(503, "center_unavailable");
    return original(...args);
  };
  w.d.operation = async () => { throw new SharedProjectsError(404, "center_rejected"); };
  expect((await createSharedProject(create, w.d)).available).toBe(false);
  const a = approve(w.asks[0]!);
  const response = await w.request("POST", `/operations/${operationId}/continue`, { askId: a.id });
  expect((await response!.json() as { available: boolean }).available).toBe(true);
  expect(attempts).toEqual([create, create]);
});

test("HTTP continue rejects a narrowed original approver before claiming or querying", async () => {
  const w = fixture();
  w.d.gateRead = async () => false;
  await createSharedProject(create, w.d);
  const a = approve(w.asks[0]!);
  Object.assign(w.d, { authorizeAnswer: async () => false });
  w.calls.length = 0;
  expect((await w.request("POST", `/operations/${operationId}/continue`, { askId: a.id }))!.status).toBe(403);
  expect(w.calls).toEqual([]);
});

test("proposal API opens bound approval without calling create", async () => {
  const w = fixture();
  const response = await w.request("POST", "/proposals", create);
  expect(response!.status).toBe(202);
  expect(w.calls).toEqual([]);
  const result = await response!.json() as { askId: string };
  expect(result.askId).toBe(w.asks[0]!.id);
  await answerSharedProject(approve(w.asks[0]!), w.d);
  expect(w.calls[0]).toBe("create");
});
