import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../src/lib/ledger-asks.js";
import type { Principal } from "../src/lib/principals.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { instanceKeySync, verifyPurpose, verifySigned } from "../src/lib/instance-key.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import type { V2ProjectMember } from "../src/lib/shared-ledger-contract-v2-projects.js";
import { parseJoinOffer, JOIN_OFFER_PATH } from "../src/lib/shared-ledger-join-offer.js";
import { sharedProjectsClientPorts } from "../src/bridge/local-api/shared-projects-client.js";
import { answerSharedProject } from "../src/bridge/local-api/shared-projects-actions.js";
import { sharedProjectsSnapshot } from "../src/bridge/local-api/shared-projects-snapshot.js";
import { handleSharedProjectsApi } from "../src/bridge/local-api/shared-projects.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "n4-invite-production-")); roots.push(dir);
  const f = createV2ProjectsFixtures(), instanceId = instanceIdSync(dir), key = instanceKeySync(dir)!;
  const source = { ...f.identity, projectId: "original-a", localProjectId: "original-a" };
  const peers: HttpPeer[] = [{ name: "transport", baseUrl: "https://transport.example", outToken: "synthetic-token",
    instanceId: "transport-instance", fp: "a".repeat(64), addedAt: "" }];
  const savePeers = () => writeFileSync(join(dir, "peers.json"), JSON.stringify({ httpPeers: peers, pendingInvites: [] }));
  savePeers();
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals: [owner] }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "original-a", name: "A", dirs: [] }] }));
  await setSharedLedgerBinding(source, dir);
  await writeSharedLedgerCredential({ ...source, localSubject: owner.id, kind: "person", baseUrl: "https://synthetic.example/",
    personId: f.person.personId, instanceId, bearer: "S".repeat(43), projects: [{ projectId: source.projectId, actions: ["read", "project"] }] }, dir);
  let members: V2ProjectMember[] = structuredClone(f.responses.members.members);
  let issued = false;
  const calls: string[] = [], requests: unknown[] = [];
  const response = { ...structuredClone(f.responses.invite), invite: { ...f.invite, expiresAt: Date.now() + 60000 } };
  const project = structuredClone(f.project);
  const fetcher = (async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe("https://synthetic.example");
    expect(init.redirect).toBe("error");
    calls.push(`${init.method} ${url.pathname}`);
    const headers = new Headers(init.headers), h = SHARED_LEDGER_AUTH_HEADERS;
    expect(headers.get("authorization")).toBe(`Bearer ${"S".repeat(43)}`);
    expect(verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", [init.method!, url.pathname, headers.get(h.ts)!,
      sharedLedgerCredentialHash(init.body as string ?? ""), headers.get(h.nonce)!, instanceId, sharedLedgerCredentialHash("S".repeat(43))], headers.get(h.sig)!)).toBe(true);
    if (url.pathname.endsWith("/members")) return Response.json({ ...f.responses.members, members });
    if (url.pathname.endsWith("/invites")) {
      requests.push(JSON.parse(init.body as string).payload); issued = true;
      members = [members[0]!, structuredClone(response.member)];
      return Response.json(response, { status: 201 });
    }
    return Response.json({ ...f.responses.list, projects: [project] });
  }) as unknown as typeof fetch;
  const asks: Ask[] = [], claimed = new Set<string>();
  const ports = () => {
    const d = sharedProjectsClientPorts(owner, source.projectId, dir, fetcher);
    d.openAsk = input => { const a = { ...input, id: `invite_${asks.length}`, state: "open", answer: null,
      fromAgent: null, extra: input.extra ?? {} } as Ask; asks.push(a); return a; };
    d.getAsk = id => asks.find(a => a.id === id) ?? null;
    d.claimAsk = a => { if (claimed.has(a.id)) return false; claimed.add(a.id); return true; };
    return d;
  };
  const request = async (recipient: unknown) => {
    const url = new URL(`http://fixture/api/v1/shared-projects/${f.project.projectId}/invite`);
    return (await handleSharedProjectsApi(new Request(url.toString(), { method: "POST", body: JSON.stringify({ peers: peers.map(p => p.name), note: "welcome", recipient }) }),
      url, { auth: async () => owner, ports: ports() }))!;
  };
  return { dir, f, key, source, peers, savePeers, response, project, asks, requests, calls, ports, request,
    members: () => members, setMembers: (value: V2ProjectMember[]) => { members = value; }, issued: () => issued };
}
function approve(a: Ask, device?: string) {
  a.state = "answered";
  a.answer = { choices: ["[button:shared_project_confirm]"], labels: [], text: "", principal: "owner:self",
    owner: true, via: "web_card", at: Date.now(), ...(device ? { device } : {}) };
  return a;
}
const originalBytes = (dir: string) => ["projects.json", "shared-ledger-bindings.json", "shared-ledger-credentials.json"]
  .map(file => readFileSync(join(dir, file), "utf8"));
function capturePeer(w: Awaited<ReturnType<typeof world>>) {
  const bodies: string[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://transport.example"); expect(url.pathname).toBe(JOIN_OFFER_PATH);
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(verifySigned(w.key.publicKey, { method: init.method!, path: url.pathname,
      ts: headers.get("x-claudestra-ts")!, body: init.body as string, sig: headers.get("x-claudestra-sig")! })).toBe("ok");
    bodies.push(init.body as string);
    return Response.json({ secret: "SECRET_RESPONSE" }, { status: 202 });
  }) as typeof fetch);
  return { bodies, mock };
}

test("real recipient/member wiring signs canonical N3 request and sends only after owner approval across adapter instances", async () => {
  for (const recipient of [{ personId: "person-peer" }, { code: "demo-peer" }]) {
    const w = await world(), original = originalBytes(w.dir), peer = capturePeer(w);
    const logs: unknown[] = [];
    const spies = (["log", "warn", "error"] as const).map(m => spyOn(console, m).mockImplementation((...args) => { logs.push(args); }));
    try {
      const response = await w.request(recipient);
      expect(response.status).toBe(202);
      const result = await response.json() as { ok: boolean; askId: string };
      expect(result).toEqual({ ok: true, askId: w.asks[0]!.id });
      expect(w.requests).toEqual([{ ...w.f.identity, ...recipient }]);
      expect(peer.bodies).toEqual([]);
      const params = w.asks[0]!.bind!.params as { invitation: { personId: string; recipient: unknown; member: unknown } };
      expect(params.invitation.personId).toBe(w.f.invite.personId);
      expect(params.invitation.recipient).toEqual(recipient);
      expect(params.invitation.member).toEqual(w.response.member);
      const sent = await answerSharedProject(approve(w.asks[0]!), w.ports());
      expect((sent!.offers as { accepted: boolean }[])[0]!.accepted).toBe(true);
      expect(peer.bodies).toHaveLength(1);
      const parsed = parseJoinOffer(JSON.parse(peer.bodies[0]!), Date.now());
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.offer.recipient).toEqual({ personId: w.f.invite.personId, instanceId: null });
      await expect(answerSharedProject(w.asks[0]!, w.ports())).rejects.toThrow();
      expect(peer.bodies).toHaveLength(1);
      expect(originalBytes(w.dir)).toEqual(original);
      const files = readdirSync(join(w.dir, "shared-ledger-join-offers-sent")).map(file => readFileSync(join(w.dir, "shared-ledger-join-offers-sent", file), "utf8"));
      const publicData = JSON.stringify([logs, result, sent, files, w.asks]);
      for (const secret of [w.f.invite.code, "F".repeat(43), "S".repeat(43), "SECRET_RESPONSE"]) expect(publicData).not.toContain(secret);
    } finally { peer.mock.mockRestore(); spies.forEach(s => s.mockRestore()); }
  }
});

test("unselected/unlisted person, absent member source and non-owner membership refuse before mint", async () => {
  for (const scenario of ["unlisted", "removed", "no-owner", "wrong-owner"]) {
    const w = await world();
    if (scenario === "removed") w.setMembers(w.members().map(m => ({ ...m, status: "removed" })));
    if (scenario === "no-owner") w.setMembers(w.members().map(m => ({ ...m, role: "member" })));
    if (scenario === "wrong-owner") w.setMembers(w.members().map(m => ({ ...m, personId: `other-${m.personId}` })));
    const result = await w.request({ personId: scenario === "unlisted" ? "unknown-person" : "person-peer" });
    expect(result.status).toBe(403); expect(w.issued()).toBe(false); expect(w.asks).toEqual([]);
  }
});

test("canonical member/invite mismatch and code response mismatch never open an approval or send", async () => {
  for (const scenario of ["person", "member", "code", "team", "project"]) {
    const w = await world(), peer = capturePeer(w);
    if (scenario === "person") w.response.invite.personId = "wrong-person";
    if (scenario === "member") Object.assign(w.response, { member: undefined });
    if (scenario === "code") w.response.member.code = "other-code";
    if (scenario === "team") w.response.member.teamId = "wrong-team";
    if (scenario === "project") w.response.invite.projectId = "wrong-project";
    try {
      expect((await w.request({ code: "demo-peer" })).status).toBe(503);
      expect(w.asks).toEqual([]); expect(peer.bodies).toEqual([]);
    } finally { peer.mock.mockRestore(); }
  }
});

test("pre-send recheck refuses withdrawn member, changed project, peer credentials, expired invitation or changed approval", async () => {
  for (const scenario of ["removed", "no-owner", "project", "peer", "expiry", "recipient", "note", "card", "withdrawal"]) {
    const w = await world(), peer = capturePeer(w), original = originalBytes(w.dir);
    try {
      expect((await w.request({ code: "demo-peer" })).status).toBe(202);
      const a = approve(w.asks[0]!);
      if (scenario === "removed") w.setMembers(w.members().map(m => m.personId === "person-peer" ? { ...m, status: "removed" } : m));
      if (scenario === "no-owner") w.setMembers(w.members().map(m => m.personId === w.f.person.personId ? { ...m, role: "member" } : m));
      if (scenario === "project") { w.project.name = "Changed"; w.project.rev++; }
      if (scenario === "peer") { w.peers[0]!.outToken = "changed-token"; w.savePeers(); }
      if (scenario === "recipient") (a.bind!.params as { invitation: { personId: string } }).invitation.personId = "other";
      if (scenario === "note") (a.bind!.params as { invitation: { noteDigest: string } }).invitation.noteDigest = "a".repeat(64);
      if (scenario === "card") a.context = "changed recipient";
      if (scenario === "withdrawal") a.state = "cancelled";
      const d = w.ports(); if (scenario === "expiry") d.now = () => Date.now() + 120000;
      if (scenario === "withdrawal") expect(await answerSharedProject(a, d)).toBeNull();
      else await expect(answerSharedProject(a, d)).rejects.toThrow();
      expect(peer.bodies).toEqual([]); expect(originalBytes(w.dir)).toEqual(original);
    } finally { peer.mock.mockRestore(); }
  }
});

test("real narrowed or revoked stored approver is refused by HTTP continue", async () => {
  const w = await world(), peer = capturePeer(w);
  try {
    expect((await w.request({ personId: "person-peer" })).status).toBe(202);
    const a = approve(w.asks[0]!, "dev_restricted");
    const createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60000).toISOString();
    writeFileSync(join(w.dir, "principals.json"), JSON.stringify({ principals: [{ ...owner, credentials: [{
      id: "dev_restricted", v: 1, type: "bearer", hash: "a".repeat(64), deviceName: "synthetic",
      grant: { agents: ["*"], terminal: true, manage: false }, createdAt, expiresAt,
    }] }] }));
    const params = a.bind!.params as { operationId: string };
    const url = new URL(`http://fixture/api/v1/shared-projects/operations/${params.operationId}/continue`);
    const result = await handleSharedProjectsApi(new Request(url.toString(), { method: "POST", body: JSON.stringify({ askId: a.id }) }),
      url, { auth: async () => owner, ports: w.ports() });
    expect(result!.status).toBe(403); expect(peer.bodies).toEqual([]);
    expect(await w.ports().authorizeAnswer(a)).toBe(false);
  } finally { peer.mock.mockRestore(); }
});

test("snapshot enables explicit-recipient invitations and keeps unavailable leave/bootstrap/team-role visible", async () => {
  const w = await world();
  const snapshot = await sharedProjectsSnapshot(w.ports(), { projects: [], peers: [{ name: "transport", enabled: true, invitable: true }] });
  expect(snapshot.capabilities.invite.available).toBe(true);
  expect(snapshot.projects[0]!.projectRole).toEqual({ available: true, value: "owner" });
  expect(snapshot.peers[0]!.invitable).toBe(true);
  expect(snapshot.capabilities.leave.available).toBe(false);
  expect(snapshot.capabilities.bootstrap.available).toBe(false);
  expect(snapshot.teamRole.available).toBe(false);
});

test("default authenticated route and durable approved card call real N3 mint and peer transport once", async () => {
  const root = mkdtempSync(join(tmpdir(), "n4-default-invite-")); roots.push(root);
  const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { attachCredential, fullGrant, DEVICE_COOKIE, DEVICE_HEADER } from "./src/lib/devices.ts";
    import { instanceIdSync } from "./src/lib/instance-id.ts";
    import { createV2ProjectsFixtures } from "./src/lib/shared-ledger-contract-v2-projects-fixtures.ts";
    import { setSharedLedgerBinding } from "./src/lib/shared-ledger-gate-bindings.ts";
    import { writeSharedLedgerCredential } from "./src/lib/shared-ledger-mode.ts";
    import { setAsksForTest, askDb } from "./src/bridge/asks.ts";
    import { answerAsk, getAsk } from "./src/lib/ledger-asks.ts";
    import { setRequestContext } from "./src/bridge/request-context.ts";
    import { handleSharedProjectsApi } from "./src/bridge/local-api/shared-projects.ts";
    import { onSharedProjectAnswered } from "./src/bridge/local-api/shared-projects-runtime.ts";
    const dir = process.env.CLAUDESTRA_STATE_DIR, f = createV2ProjectsFixtures();
    mkdirSync(dir, { recursive: true });
    const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "" };
    const full = attachCredential(owner, "synthetic-full", fullGrant());
    writeFileSync(dir + "/principals.json", JSON.stringify({ principals: [owner] }));
    writeFileSync(dir + "/projects.json", JSON.stringify({ projects: [{ id: "original-a", name: "A", dirs: [] }] }));
    writeFileSync(dir + "/peers.json", JSON.stringify({ httpPeers: [{ name: "transport", baseUrl: "https://transport.example", outToken: "synthetic-peer", addedAt: "" }] }));
    const original = { ...f.identity, projectId: "original-a", localProjectId: "original-a" };
    await setSharedLedgerBinding(original);
    await writeSharedLedgerCredential({ ...original, localSubject: owner.id, kind: "person", baseUrl: "https://synthetic.example/",
      personId: f.person.personId, instanceId: instanceIdSync(), bearer: "S".repeat(43), projects: [{ projectId: original.projectId, actions: ["read", "project"] }] });
    setAsksForTest({ path: dir + "/cards.sqlite" });
    const posts = [], mints = [], notices = [];
    globalThis.fetch = async (url, init) => {
      url = new URL(url); assert.equal(init.redirect, "error");
      if (url.origin === "https://transport.example") { posts.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); }
      assert.equal(url.origin, "https://synthetic.example");
      if (url.pathname.endsWith("/members")) return Response.json(f.responses.members);
      if (url.pathname.endsWith("/invites")) {
        mints.push(JSON.parse(init.body).payload);
        return Response.json({ ...f.responses.invite, invite: { ...f.invite, expiresAt: Date.now() + 60000 } }, { status: 201 });
      }
      return Response.json(f.responses.list);
    };
    const url = new URL("http://fixture/api/v1/shared-projects/" + f.project.projectId + "/invite");
    const req = new Request(url.toString(), { method: "POST", headers: { cookie: DEVICE_COOKIE + "=" + full.token, [DEVICE_HEADER]: "1" },
      body: JSON.stringify({ peers: ["transport"], recipient: { code: "demo-peer" }, note: "welcome" }) });
    setRequestContext(req, { source: "loopback", clientIp: null, https: false });
    const response = await handleSharedProjectsApi(req, url), result = await response.json();
    assert.equal(response.status, 202); assert.equal(posts.length, 0);
    assert.deepEqual(mints, [{ ...f.identity, code: "demo-peer" }]);
    const card = getAsk(askDb(), result.askId);
    assert.ok(!JSON.stringify(card).includes(f.invite.code));
    const approved = answerAsk(askDb(), card.id, { principal: owner.id, device: full.credential.id, owner: true, via: "web_card",
      choices: ["[button:shared_project_confirm]"], labels: [], text: "", final: true, at: Date.now() });
    await onSharedProjectAnswered(approved, async text => { notices.push(text); });
    assert.equal(posts.length, 1); assert.equal(posts[0].projectInvite.personId, f.invite.personId);
    assert.equal(posts[0].code, f.invite.code); assert.equal(notices.length, 1);
    assert.equal(getAsk(askDb(), card.id).extra.sharedProjectExecuted, true);
    await onSharedProjectAnswered(approved);
    assert.equal(posts.length, 1);
    console.log("default-invite-passed");
  `;
  const { testChildEnv } = await import("./test-env.js");
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: process.cwd(),
    env: testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"),
      CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), DISCORD_CHANNEL_ID: "" }), stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0); expect(stderr).toBe("shared project authorization or completion rejected\n");
  expect(stdout).toContain("default-invite-passed");
});
