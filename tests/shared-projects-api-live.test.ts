import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import type { Ask } from "../src/lib/ledger-asks.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { instanceKeySync, verifyPurpose } from "../src/lib/instance-key.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { sharedLedgerJoinFields, SHARED_LEDGER_JOIN_PURPOSE, parseSharedLedgerJoinCode } from "../src/lib/shared-ledger-join-protocol.js";
import { setSharedLedgerBinding, readSharedLedgerBindings, type SharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { writeSharedLedgerCredential, resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "../src/lib/shared-ledger-mode.js";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { SHARED_LEDGER_LIST_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import { sharedProjectsClientPorts } from "../src/bridge/local-api/shared-projects-client.js";
import { enrollSharedProject } from "../src/bridge/local-api/shared-projects-enrollment.js";
import { answerSharedProject, createSharedProject, proposeSharedProject } from "../src/bridge/local-api/shared-projects-actions.js";
import { readSharedProjectCompletion, sharedProjectBindingGeneration } from "../src/bridge/local-api/shared-projects-completion.js";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects.js";
import type { SharedProjectsPorts } from "../src/bridge/local-api/shared-projects-ports.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "n4-real-ports-")); roots.push(dir);
  const f = createV2ProjectsFixtures(), instanceId = instanceIdSync(dir), key = instanceKeySync(dir)!;
  const source = { centerId: f.identity.centerId, teamId: f.identity.teamId, projectId: "original-a", localProjectId: "original-a" };
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: ["original-a", "existing-b"].map(id => ({ id, name: id, dirs: [] })) }));
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals: [owner] }));
  await setSharedLedgerBinding(source, dir);
  await writeSharedLedgerCredential({ ...source, localSubject: owner.id, kind: "person", baseUrl: "https://synthetic.example/",
    personId: f.person.personId, instanceId, bearer: "S".repeat(43), projects: [{ projectId: source.projectId, actions: ["read", "project"] }] }, dir);
  const operation = { ...f.operation, instanceId };
  const invite = { ...f.creatorInvite, instanceId, expiresAt: Date.now() + 60000 };
  const grant = { ...f.grant, instanceId, expiresAt: Date.now() + 60000 };
  const calls: string[] = [];
  let gateFails = false;
  const fetcher = (async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe("https://synthetic.example");
    expect(init.redirect).toBe("error");
    calls.push(`${init.method} ${url.pathname}`);
    if (url.pathname === "/v1/join") {
      const request = JSON.parse(init.body as string);
      const code = parseSharedLedgerJoinCode(request.code)!;
      expect(request.instanceId).toBe(instanceId);
      expect(verifyPurpose(key.publicKey, SHARED_LEDGER_JOIN_PURPOSE,
        sharedLedgerJoinFields(code.centerId, request.code, request.publicKey, instanceId), request.signature)).toBe(true);
      return Response.json(grant);
    }
    const headers = new Headers(init.headers), h = SHARED_LEDGER_AUTH_HEADERS;
    const bearer = headers.get("authorization")!.slice(7), body = init.body as string | undefined;
    expect(verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", [init.method!, url.pathname, headers.get(h.ts)!,
      sharedLedgerCredentialHash(body ?? ""), headers.get(h.nonce)!, instanceId, sharedLedgerCredentialHash(bearer)], headers.get(h.sig)!)).toBe(true);
    if (url.pathname.endsWith("/features")) {
      if (gateFails && calls.filter(s => s.endsWith("/features")).length > 1) return Response.json({}, { status: 403 });
      expect(bearer).toBe(grant.bearer);
      return Response.json({ ...SHARED_LEDGER_LIST_FIXTURE, teamId: f.identity.teamId, features: [] });
    }
    expect(bearer).toBe("S".repeat(43));
    if (url.pathname.endsWith("/creator-credential")) return Response.json({ ok: true, v: 2, project: f.project, operation, creatorInvite: invite });
    if (url.pathname.startsWith("/v1/projects/operations/")) return Response.json({ ok: true, v: 2, project: f.project, operation });
    if (url.pathname.endsWith("/members")) return Response.json(f.responses.members);
    if (url.pathname.endsWith("/remove")) return Response.json(f.responses.removeMember);
    if (init.method === "POST") return Response.json({ ok: true, v: 2, project: f.project, operation, creatorInvite: invite }, { status: 201 });
    if (init.method === "PATCH") return Response.json(f.responses.update);
    return Response.json(f.responses.list);
  }) as unknown as typeof fetch;
  const asks: Ask[] = [], claimed = new Set<string>();
  let receiptFails = false;
  const ports = () => {
    const d = sharedProjectsClientPorts(owner, source.projectId, dir, fetcher);
    d.openAsk = input => { const ask = { ...input, id: `ask_${asks.length}`, state: "open", answer: null,
      fromAgent: null, extra: input.extra ?? {} } as Ask; asks.push(ask); return ask; };
    d.getAsk = id => asks.find(a => a.id === id) ?? null;
    d.claimAsk = a => { if (claimed.has(a.id)) return false; claimed.add(a.id);
      const card = asks.find(c => c.id === a.id); if (card) card.extra = { ...card.extra, sharedProjectExecuted: true }; return true; };
    // N4R receipts share the in-memory card store (CAS: claimed, no earlier receipt); the real-ledger port is covered in shared-projects-completion.test.ts.
    d.recordCompletion = (a, receipt) => {
      const card = asks.find(c => c.id === a.id);
      if (receiptFails || !card || !claimed.has(a.id) || card.extra.sharedProjectCompletion) return false;
      card.extra = { ...card.extra, sharedProjectCompletion: receipt }; return true;
    };
    d.completionAsks = id => asks.filter(c => (c.bind?.params as { operationId?: string } | undefined)?.operationId === id);
    d.bindingGeneration = sharedProjectBindingGeneration(dir); // This adapter's isolated state dir, not the canonical one.
    return d;
  };
  return { dir, f, source, instanceId, grant, fetcher, calls, asks, ports, gateFailure: (value: boolean) => { gateFails = value; },
    receiptFailure: (value: boolean) => { receiptFails = value; } };
}
function approve(a: Ask, choice?: string) {
  a.state = "answered";
  a.answer = { choices: ["[button:shared_project_confirm]", ...(choice ? [choice] : [])], labels: [], text: "", principal: owner.id,
    owner: true, via: "web_card", at: Date.now() };
  return a;
}
const bytes = (dir: string) => ["projects.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json"].map(file =>
  existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null);
async function request(d: SharedProjectsPorts, method: string, path = "", body?: unknown) {
  const url = new URL(`http://fixture/api/v1/shared-projects${path}`);
  return (await handleSharedProjectsApi(new Request(url.toString(), { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url,
    { auth: async () => owner, ports: async principal => { expect(principal).toBe(owner); return d; } }))!;
}

test("actual N4 owner adapter signs N3 create, N2 exchange and a persisted B read through the real gate", async () => {
  const w = await world(), d = w.ports(), a = resolveSharedLedgerCredential(owner.id, "person", w.source.centerId, w.source.teamId, w.source.projectId, "read", w.dir);
  const response = await request(d, "POST", "", { operationId: w.f.operation.operationId, id: w.f.project.projectId,
    name: w.f.project.name, selection: { mode: "create" } });
  const result = await response.json() as { available: boolean };
  expect(result.available).toBe(true);
  expect(w.calls).toEqual(["POST /v1/projects", "POST /v1/join", `GET /v1/teams/${w.source.teamId}/features`, `GET /v1/teams/${w.source.teamId}/features`]);
  expect(readSharedLedgerBindings(w.dir)).toHaveLength(2);
  expect(resolveSharedLedgerCredential(owner.id, "person", w.source.centerId, w.source.teamId, w.source.projectId, "read", w.dir)).toEqual(a);
  expect(JSON.stringify(result)).not.toContain(w.f.creatorInvite.code);
  expect(JSON.stringify(w.asks)).not.toContain(w.grant.bearer);
});

test("new project selection and approved source identity survive adapter restart without a second create", async () => {
  const w = await world(), before = bytes(w.dir);
  await createSharedProject({ operationId: w.f.operation.operationId, name: w.f.project.name }, w.ports());
  expect(w.calls).toEqual(["POST /v1/projects"]);
  expect(bytes(w.dir)).toEqual(before);
  const card = w.asks[0]!;
  expect(JSON.stringify(card)).not.toContain(w.f.creatorInvite.code);
  expect((card.bind!.params as { who: { sourceBinding: unknown } }).who.sourceBinding).toEqual(w.source);
  const result = await answerSharedProject(approve(card, "[select:shared_project_local:local_existing-b]"), w.ports());
  expect(result!.available).toBe(true);
  expect(result!.localProjectId).toBe("existing-b");
  expect(w.calls.filter(s => s === "POST /v1/projects")).toHaveLength(1);
  expect(w.calls).toContain(`GET /v1/projects/operations/${w.f.operation.operationId}`);
  expect(w.calls).toContain(`POST /v1/projects/${w.f.project.projectId}/creator-credential`);
});

test("real gate failure keeps visible original recovery and reuses saved binding on owner retry", async () => {
  const w = await world(); w.gateFailure(true);
  const input = { operationId: w.f.operation.operationId, name: w.f.project.name, selection: { mode: "create" as const } };
  expect((await createSharedProject(input, w.ports())).available).toBe(false);
  expect(w.asks[0]!.title).toBe("继续完成项目");
  const before = bytes(w.dir); w.gateFailure(false);
  expect((await answerSharedProject(approve(w.asks[0]!), w.ports()))!.available).toBe(true);
  expect(bytes(w.dir)).toEqual(before);
  expect(w.calls.filter(s => s === "POST /v1/join")).toHaveLength(1);
});

test("N4R receipt write failure stays pending; the owner-approved retry persists it and only then is available", async () => {
  const w = await world(), d = w.ports(), op = w.f.operation.operationId, who = await d.person();
  expect((await createSharedProject({ operationId: op, name: w.f.project.name, selection: { mode: "create" } }, d)).available).toBe(true);
  expect((await readSharedProjectCompletion(who, op, d)).state).toBe("unknown"); // Direct HTTP without a card records nothing.
  w.receiptFailure(true);
  const first = await answerSharedProject(approve((await proposeSharedProject({ operationId: op, name: w.f.project.name, selection: { mode: "create" } }, d))), d);
  expect(first!.available).toBe(false);
  expect(await readSharedProjectCompletion(who, op, d)).toMatchObject({ state: "pending", openAskId: first!.askId });
  w.receiptFailure(false);
  expect((await answerSharedProject(approve(w.asks.find(a => a.id === first!.askId)!), d))!.available).toBe(true);
  expect(await readSharedProjectCompletion(who, op, d)).toMatchObject({ state: "completed", askId: first!.askId });
  expect(w.calls.filter(s => s === "POST /v1/join")).toHaveLength(1);
});

async function completedViaCard(w: Awaited<ReturnType<typeof world>>) {
  const d = w.ports(), op = w.f.operation.operationId, input = { operationId: op, name: w.f.project.name, selection: { mode: "create" as const } };
  const card = await proposeSharedProject(input, d);
  expect((await answerSharedProject(approve(card), d))!.available).toBe(true);
  const who = await d.person();
  expect(await readSharedProjectCompletion(who, op, d)).toMatchObject({ state: "completed", askId: card.id });
  return { d, op, who, calls: w.calls.length };
}

test("N4R: removing only B's local credential (A and both bindings intact) reads stale, with no center call or local write", async () => {
  const w = await world(), { d, op, who, calls } = await completedViaCard(w);
  const path = join(w.dir, "shared-ledger-credentials.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as { credentials: SharedLedgerLocalCredential[] };
  writeFileSync(path, JSON.stringify({ credentials: file.credentials.filter(c => !c.projects.some(p => p.projectId === w.f.project.projectId)) }), { mode: 0o600 });
  expect(await d.credentialSaved(who, w.f.project)).toBe(false);
  expect(resolveSharedLedgerCredential(owner.id, "person", w.source.centerId, w.source.teamId, w.source.projectId, "read", w.dir)).not.toBeNull();
  const before = bytes(w.dir);
  expect(await readSharedProjectCompletion(who, op, d)).toEqual({ ok: true, operationId: op, state: "stale" });
  expect((await (await request(d, "GET", `/operations/${op}/completion`)).json() as { state: string }).state).toBe("stale");
  expect(bytes(w.dir)).toEqual(before);
  expect(w.calls).toHaveLength(calls);
});

test("N4R: removing B's binding and re-adding the identical row through setSharedLedgerBinding never revives the receipt", async () => {
  const w = await world(), { d, op, who, calls } = await completedViaCard(w);
  const all = readSharedLedgerBindings(w.dir), b = all.find(x => x.projectId === w.f.project.projectId) as SharedLedgerBinding;
  writeFileSync(join(w.dir, "shared-ledger-bindings.json"), JSON.stringify(all.filter(x => x !== b)), { mode: 0o600 });
  expect((await readSharedProjectCompletion(who, op, d)).state).toBe("stale");
  await setSharedLedgerBinding(b, w.dir);
  expect(readSharedLedgerBindings(w.dir)).toEqual(all);
  const before = bytes(w.dir);
  expect(await readSharedProjectCompletion(who, op, d)).toEqual({ ok: true, operationId: op, state: "stale" });
  expect(bytes(w.dir)).toEqual(before);
  expect(w.calls).toHaveLength(calls);
});

test("wrong grant identity, display, instance and service grant preserve every local byte", async () => {
  for (const change of [{ personId: "other-person" }, { instanceId: "other-instance" }, { role: "service" as const },
    { project: { ...createV2ProjectsFixtures().display, name: "wrong name" } }]) {
    const w = await world(), before = bytes(w.dir);
    Object.assign(w.grant, change);
    await expect(enrollSharedProject("https://synthetic.example/", w.f.creatorInvite.code, { mode: "existing", localProjectId: "existing-b" },
      { ...w.f.display, centerId: w.source.centerId, personId: w.f.person.personId, instanceId: w.instanceId }, w.dir, w.fetcher)).rejects.toThrow();
    expect(bytes(w.dir)).toEqual(before);
  }
});

test("real list/members/CAS/local dirs work; recipient is required and leave/deployment stay unavailable", async () => {
  const w = await world(), d = w.ports();
  expect((await request(d, "GET")).status).toBe(200);
  expect((await request(d, "GET", `/${w.f.project.projectId}/members`)).status).toBe(200);
  expect((await request(d, "PATCH", `/${w.f.project.projectId}`, { rev: 1, name: w.f.requests.update.name, status: "archived" })).status).toBe(200);
  expect((await request(d, "POST", `/${w.f.project.projectId}/members/${w.f.invite.personId}/remove`, {})).status).toBe(200);
  expect((await request(d, "PATCH", "/original-a/dirs", { localProjectId: "original-a", dirs: ["/synthetic/a"] })).status).toBe(200);
  const before = [...w.calls];
  expect((await request(d, "POST", "/original-a/invite", { peers: ["transport-peer"] })).status).toBe(400);
  expect((await request(d, "POST", "/original-a/leave", { localProjectId: "original-a" })).status).toBe(503);
  expect((await request(d, "POST", "/owner-bootstrap", { operationId: w.f.operation.operationId })).status).toBe(403);
  expect(w.calls).toEqual(before);
});

test("changed original credential or approval scope rejects before create, redemption or writes", async () => {
  const w = await world(), d = w.ports(), input = { operationId: w.f.operation.operationId, name: w.f.project.name };
  const a = await proposeSharedProject(input, d);
  const c = resolveSharedLedgerCredential(owner.id, "person", w.source.centerId, w.source.teamId, w.source.projectId, "read", w.dir)!;
  await writeSharedLedgerCredential({ ...c, personId: "other-person" }, w.dir);
  const before = bytes(w.dir);
  await expect(answerSharedProject(approve(a), w.ports())).rejects.toThrow();
  expect(w.calls).toEqual([]); expect(bytes(w.dir)).toEqual(before);
});

test("default API and card callback resolve actual device principal and preserved source binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "n4-default-api-")); roots.push(root);
  const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { attachCredential, fullGrant, DEVICE_COOKIE, DEVICE_HEADER } from "./src/lib/devices.ts";
    import { createV2ProjectsFixtures } from "./src/lib/shared-ledger-contract-v2-projects-fixtures.ts";
    import { SHARED_LEDGER_LIST_FIXTURE } from "./src/lib/shared-ledger-contract-fixtures.ts";
    import { instanceIdSync } from "./src/lib/instance-id.ts";
    import { setSharedLedgerBinding, readSharedLedgerBindings } from "./src/lib/shared-ledger-gate-bindings.ts";
    import { writeSharedLedgerCredential } from "./src/lib/shared-ledger-mode.ts";
    import { setRequestContext } from "./src/bridge/request-context.ts";
    import { setAsksForTest, askDb } from "./src/bridge/asks.ts";
    import { getAsk, answerAsk } from "./src/lib/ledger-asks.ts";
    import { handleSharedProjectsApi } from "./src/bridge/local-api/shared-projects.ts";
    import { onSharedProjectAnswered } from "./src/bridge/local-api/shared-projects-runtime.ts";
    const dir = process.env.CLAUDESTRA_STATE_DIR, f = createV2ProjectsFixtures();
    mkdirSync(dir, { recursive: true });
    const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "" };
    const full = attachCredential(owner, "synthetic-full", fullGrant());
    const restricted = attachCredential(owner, "synthetic-restricted", { ...fullGrant(), manage: false });
    writeFileSync(dir + "/principals.json", JSON.stringify({ principals: [owner] }), { mode: 0o600 });
    writeFileSync(dir + "/projects.json", JSON.stringify({ projects: [{ id: "original-a", name: "A", dirs: [] }] }));
    const original = { centerId: f.identity.centerId, teamId: f.identity.teamId, projectId: "original-a", localProjectId: "original-a" };
    await setSharedLedgerBinding(original);
    const instanceId = instanceIdSync();
    await writeSharedLedgerCredential({ ...original, localSubject: owner.id, kind: "person", baseUrl: "https://synthetic.example/",
      personId: f.person.personId, instanceId, bearer: "S".repeat(43), projects: [{ projectId: original.projectId, actions: ["read", "project"] }] });
    setAsksForTest({ path: dir + "/cards.sqlite" });
    const operation = { ...f.operation, instanceId }, creatorInvite = { ...f.creatorInvite, instanceId, expiresAt: Date.now() + 60000 };
    const calls = [], informs = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(url.origin, "https://synthetic.example"); calls.push(init.method + " " + url.pathname);
      if (url.pathname === "/v1/join") return Response.json({ ...f.grant, instanceId, expiresAt: Date.now() + 60000 });
      if (url.pathname.endsWith("/features")) return Response.json({ ...SHARED_LEDGER_LIST_FIXTURE, teamId: f.identity.teamId, features: [] });
      if (url.pathname.endsWith("/creator-credential")) return Response.json({ ok: true, v: 2, project: f.project, operation, creatorInvite });
      if (url.pathname.startsWith("/v1/projects/operations/")) return Response.json({ ok: true, v: 2, project: f.project, operation });
      return Response.json({ ok: true, v: 2, project: f.project, operation, creatorInvite }, { status: 201 });
    };
    const url = new URL("http://fixture/api/v1/shared-projects");
    const request = token => {
      const req = new Request(url, { method: "POST", headers: { cookie: DEVICE_COOKIE + "=" + token, [DEVICE_HEADER]: "1" },
        body: JSON.stringify({ operationId: operation.operationId, name: f.project.name }) });
      setRequestContext(req, { source: "loopback", clientIp: null, https: false }); return req;
    };
    assert.equal((await handleSharedProjectsApi(request(restricted.token), url)).status, 403);
    assert.deepEqual(calls, []);
    const response = await handleSharedProjectsApi(request(full.token), url), result = await response.json();
    assert.equal(result.available, false);
    assert.deepEqual(calls, ["POST /v1/projects"]);
    const card = getAsk(askDb(), result.askId);
    const approved = answerAsk(askDb(), card.id, { principal: owner.id, device: full.credential.id, owner: true, via: "web_card",
      choices: ["[select:shared_project_local:create]", "[button:shared_project_confirm]"], labels: [], text: "", final: true, at: Date.now() });
    await onSharedProjectAnswered(approved, async text => { informs.push(text); });
    assert.equal(readSharedLedgerBindings().length, 2);
    assert.equal(informs.length, 1); assert.ok(informs[0].includes("项目可用"));
    assert.equal(calls.filter(s => s === "POST /v1/projects").length, 1);
    console.log("actual-default-api-passed");
  `;
  const { testChildEnv } = await import("./test-env.js");
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: process.cwd(),
    env: testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"),
      CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), DISCORD_CHANNEL_ID: "" }), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("actual-default-api-passed");
});
