import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Ask } from "../src/lib/ledger-asks.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { parseJoinOffer, joinOfferCard, claimPendingOffer } from "../src/lib/shared-ledger-join-offer.js";
import { receiveJoinOffer, onJoinOfferAnswered, setSharedProjectAuditHook, sweepJoinOfferMaintenance,
  type JoinOfferDeps, type JoinOfferExpectedProject, sweepJoinOffers } from "../src/bridge/shared-ledger-join-offer.js";
import { sharedProjectsClientPorts } from "../src/bridge/local-api/shared-projects-client.js";
import { answerSharedProject } from "../src/bridge/local-api/shared-projects-actions.js";
import { projectChoices } from "../src/bridge/local-api/shared-projects-choice.js";
import { proposeSharedProjectInvite, sendApprovedSharedProjectInvite, type ProjectInvitePorts } from "../src/bridge/local-api/shared-projects-invite.js";

const centerId = "center-" + "c".repeat(32);
const code = `sljoin1.${centerId}.${"a".repeat(32)}.${"M".repeat(43)}`;
const project = { teamId: "team", projectId: "project-b", name: "Project B" };
const projectInvite = () => ({ ...createV2ProjectsFixtures().invite, centerId, teamId: project.teamId, projectId: project.projectId,
  personId: "alice", instanceId: null, codeId: "a".repeat(32), code, expiresAt: Date.now() + 60000 });
const expected: JoinOfferExpectedProject = { ...project, centerId, personId: "alice" };
const roots: string[] = [];
afterEach(() => { setSharedProjectAuditHook(undefined); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), "n4-join-")); roots.push(r); return r; };
const peer = (): HttpPeer => ({ name: `peer-${randomBytes(4).toString("hex")}`, baseUrl: "https://peer.example", outToken: "synthetic-token", addedAt: "" });
const wire = () => ({ v: 1, offerId: randomBytes(16).toString("hex"), url: "https://center.example/", code, project, projectInvite: projectInvite() });
function world() {
  const dir = root(), p = peer(), asks: Ask[] = [], receipts: string[] = [], joined: unknown[] = [];
  const d: JoinOfferDeps = {
    stateDir: () => dir, now: () => Date.now(), peers: async () => [p], projects: async () => [{ id: "local-b", name: "Project B", lastActivityAt: 0 }],
    bindings: () => [],
    openAsk: input => { const a = { ...input, id: `ask_${asks.length}`, state: "open", answer: null, extra: input.extra ?? {} } as Ask; asks.push(a); return a; },
    getAsk: id => asks.find(a => a.id === id) ?? null, closeAsk: () => {},
    join: async () => { throw new Error("legacy join must not run"); },
    joinProject: async (_url, _code, selection, expected) => {
      joined.push({ selection, expected });
      return { centerId, teamId: "team", personId: "alice", projectId: "project-b", localProjectId: "local-b", kind: "person", expiresAt: Date.now() + 60000, identities: 1 };
    },
    inform: async () => {}, sendReceipt: async (_peer, body) => { receipts.push(JSON.parse(body).status); return 200; }, writeNote: async () => {},
  };
  return { d, dir, p, asks, receipts, joined };
}
function answer(a: Ask, values = ["[select:shared_project_local:create]", "[button:sl_join_accept]"]): Ask {
  return { ...a, state: "answered", answer: { choices: values, labels: [], text: "", principal: "owner:self", owner: true, via: "web_card", at: Date.now() } };
}

test("project metadata is bounded, secret-free and rendered without inferring identity", () => {
  const parsed = parseJoinOffer(wire(), Date.now());
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(joinOfferCard({ ...parsed.offer, peer: "fixture" }).context).toContain("Project B（project-b）");
  for (const bad of [{ ...project, name: code }, { ...project, name: "M".repeat(43) }, { ...project, projectId: "../b" }, { ...project, name: "bad\nname" }, { ...project, extra: "x" }]) {
    expect(parseJoinOffer({ ...wire(), project: bad }, Date.now()).ok).toBe(false);
  }
});

test("unique case-insensitive name/id preselects existing; ambiguous/absent match defaults create; every unbound candidate is retained", () => {
  const all = ["one", "two", "three", "four"].map(id => ({ id, name: id }));
  expect(projectChoices(project, [...all, { id: "local", name: "PROJECT B" }], []).recommended).toBe("local_local");
  expect(projectChoices(project, [...all, { id: "project-b", name: "other" }, { id: "local", name: "Project B" }], []).recommended).toBe("create");
  expect(projectChoices(project, all, []).choices).toHaveLength(5);
  const bound = [{ centerId, teamId: "team", projectId: "project-b", localProjectId: "local" }];
  expect(projectChoices(project, [{ id: "local", name: "Project B" }], bound).choices.map(c => c.value)).toEqual(["create"]);
});

test("new project can be accepted on an empty machine only with select plus join", async () => {
  for (const values of [["[button:sl_join_accept]"], ["[select:shared_project_local:create]"],
    ["[select:shared_project_local:create,local_local-b]", "[button:sl_join_accept]"]]) {
    const w = world(); w.d.projects = async () => [];
    expect((await receiveJoinOffer(w.p, wire(), w.d)).status).toBe(202);
    await onJoinOfferAnswered(answer(w.asks[0]!, values), w.d);
    expect(w.joined).toEqual([]); expect(w.receipts).toEqual(["failed"]);
  }
  const w = world(); w.d.projects = async () => [];
  let audited = 0; setSharedProjectAuditHook(async () => { audited++; });
  await receiveJoinOffer(w.p, wire(), w.d);
  await onJoinOfferAnswered(answer(w.asks[0]!), w.d);
  expect(w.joined).toEqual([{ selection: { mode: "create" }, expected }]);
  expect(w.receipts).toEqual(["joined"]); expect(audited).toBe(1);
});

test("N2 adapter is mandatory, project mismatch returns failed, and stale local selection cannot redeem", async () => {
  for (const scenario of ["absent", "mismatch", "bound", "deleted"]) {
    const w = world();
    await receiveJoinOffer(w.p, wire(), w.d);
    if (scenario === "absent") w.d.joinProject = undefined;
    if (scenario === "mismatch") w.d.joinProject = async () => { throw new Error("N2 rejected expectedProject before credential/binding writes"); };
    if (scenario === "bound") w.d.bindings = () => [{ centerId, teamId: "team", projectId: "else", localProjectId: "local-b" }];
    if (scenario === "deleted") w.d.projects = async () => [];
    await onJoinOfferAnswered(answer(w.asks[0]!, ["[select:shared_project_local:local_local-b]", "[button:sl_join_accept]"]), w.d);
    expect(w.joined).toEqual([]); expect(w.receipts).toEqual(["failed"]);
  }
});

test("changing displayed project, even only its name, invalidates owner approval", async () => {
  const w = world(); await receiveJoinOffer(w.p, wire(), w.d);
  const a = answer(w.asks[0]!);
  (a.bind!.params as { project: typeof project }).project = { ...project, name: "Other" };
  // Persisted offer remains the authoritative parameters for ask-check.
  await onJoinOfferAnswered(a, w.d);
  expect(w.joined).toEqual([]); expect(w.receipts).toEqual(["failed"]);
});

test("N6 audit still runs if the invitation store fails; no old rebind implementation is invoked", async () => {
  const w = world(); let audited = 0;
  w.d.stateDir = () => { throw new Error("synthetic failure"); };
  const log = spyOn(console, "error").mockImplementation(() => {});
  setSharedProjectAuditHook(async () => { audited++; });
  try { await sweepJoinOfferMaintenance(w.d); } finally { log.mockRestore(); }
  expect(audited).toBe(1);
});

function senderWorld(p: HttpPeer) {
  const dir = root(), f = createV2ProjectsFixtures();
  const who = { subject: "owner:self", kind: "person", centerId, teamId: "team", personId: "owner-person", instanceId: "instance" } as const;
  const record = { ...f.project, ...project, centerId };
  const recipient = { ...f.responses.invite.member, centerId, teamId: "team", projectId: project.projectId, personId: "alice" };
  const self = { ...recipient, personId: who.personId, code: "Owner", role: "owner" as const, status: "active" as const };
  const asks: Ask[] = [], claimed = new Set<string>();
  const actions = sharedProjectsClientPorts({ id: "owner:self", role: "owner", agents: ["*"], createdAt: "" }, null, dir, fetch,
    { centerId, teamId: "team", projectId: "original" });
  actions.person = async () => who;
  actions.authorizeAnswer = async () => true;
  actions.openAsk = input => { const a = { ...input, id: `sender_${asks.length}`, state: "open", answer: null,
    fromAgent: null, extra: input.extra ?? {} } as Ask; asks.push(a); return a; };
  actions.getAsk = id => asks.find(a => a.id === id) ?? null;
  actions.claimAsk = a => { if (claimed.has(a.id)) return false; claimed.add(a.id); return true; };
  const d: ProjectInvitePorts = { now: () => Date.now(), stateDir: dir, peers: async () => [p], receiptProject: "local-a",
    project: async () => record, members: async () => [self, recipient],
    mint: async () => ({ url: "https://center.example/", project: record, invite: projectInvite(), member: recipient }),
    post: async () => new Response(null, { status: 202 }) };
  actions.sendInvite = (person, a) => sendApprovedSharedProjectInvite(person, a, actions, d);
  return { dir, who, asks, actions, d };
}

test("N3 member and invite remain in memory; only approved signed peer POST carries the secret", async () => {
  const p = peer(), w = senderWorld(p), bodies: string[] = [], logs: unknown[] = [];
  const spies = (["log", "warn", "error"] as const).map(m => spyOn(console, m).mockImplementation((...args) => { logs.push(args); }));
  try {
    w.d.post = async (_peer, _url, body) => { bodies.push(body); return new Response("SECRET_RESPONSE", { status: 202 }); };
    const result = await proposeSharedProjectInvite(w.who, "project-b", [p.name], "welcome", { personId: "alice" }, w.actions, w.d);
    expect(bodies).toEqual([]);
    const a = w.asks[0]!;
    Object.assign(a, { state: "answered", answer: { choices: ["[button:shared_project_confirm]"], labels: [], text: "",
      principal: "owner:self", owner: true, via: "web_card", at: Date.now() } });
    const sent = await answerSharedProject(a, w.actions);
    expect((sent!.offers as { accepted: boolean }[])[0]!.accepted).toBe(true);
    expect(JSON.parse(bodies[0]!).code).toBe(code); expect(JSON.parse(bodies[0]!).project).toEqual(project);
    const files = readdirSync(join(w.dir, "shared-ledger-join-offers-sent")).map(f => readFileSync(join(w.dir, "shared-ledger-join-offers-sent", f), "utf8"));
    const publicData = JSON.stringify([files, logs, result, sent, w.asks]);
    for (const secret of [code, "M".repeat(43), "SECRET_RESPONSE"]) expect(publicData).not.toContain(secret);
  } finally { spies.forEach(s => s.mockRestore()); }
});

test("plaintext or unconfigured transport peers are rejected before minting", async () => {
  const p = peer(); p.baseUrl = "http://peer.example";
  const w = senderWorld(p); let minted = false;
  w.d.mint = async () => { minted = true; throw new Error("must not run"); };
  await expect(proposeSharedProjectInvite(w.who, "project-b", [p.name], undefined, { personId: "alice" }, w.actions, w.d)).rejects.toThrow();
  expect(minted).toBe(false);
});


test("project offer requires original canonical invite; claimed person or scoped/code mismatch is refused before cards", async () => {
  for (const mutation of [undefined, { ...projectInvite(), personId: undefined }, { ...projectInvite(), teamId: "other" },
    { ...projectInvite(), projectId: "other" }, { ...projectInvite(), code: code.replace(/M/g, "N") }]) {
    const w = world();
    expect((await receiveJoinOffer(w.p, { ...wire(), projectInvite: mutation }, w.d)).status).toBe(400);
    expect(w.asks).toEqual([]); expect(w.joined).toEqual([]);
  }
  const w = world();
  expect((await receiveJoinOffer(w.p, { ...wire(), personId: "alice" }, w.d)).status).toBe(400);
});

test("person and fixed instance are bound before redemption; changing recipient invalidates approval", async () => {
  const w = world(), offer = { ...wire(), projectInvite: { ...projectInvite(), instanceId: "receiver-instance" } };
  await receiveJoinOffer(w.p, offer, w.d);
  const params = w.asks[0]!.bind!.params as { recipient: { personId: string; instanceId: string }; inviteDigest: string };
  expect(params.recipient).toEqual({ personId: "alice", instanceId: "receiver-instance" });
  expect(params.inviteDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(w.asks)).not.toContain(code);
  await onJoinOfferAnswered(answer(w.asks[0]!), w.d);
  expect(w.joined).toEqual([{ selection: { mode: "create" },
    expected: { ...project, centerId, personId: "alice", instanceId: "receiver-instance" } }]);
  const forged = world(); await receiveJoinOffer(forged.p, wire(), forged.d);
  (forged.asks[0]!.bind!.params as { recipient: { personId: string } }).recipient.personId = "other";
  await onJoinOfferAnswered(answer(forged.asks[0]!), forged.d);
  expect(forged.joined).toEqual([]); expect(forged.receipts).toEqual(["failed"]);
});

test("invitation secret hidden in a hostname never reaches card or log metadata", () => {
  const f = createV2ProjectsFixtures();
  const body = { v: 1, offerId: "a".repeat(32), code: f.creatorInvite.code,
    url: `https://${"F".repeat(43).toLowerCase()}.example/`, project: f.display,
    projectInvite: { ...f.creatorInvite, expiresAt: Date.now() + 60000 } };
  expect(parseJoinOffer(body, Date.now())).toEqual({ ok: false, error: "invalid_url" });
});

test("changed invitation card identity text or selector labels produces failed receipt without redemption", async () => {
  for (const field of ["title", "context", "options"] as const) {
    const w = world(); await receiveJoinOffer(w.p, wire(), w.d);
    const a = answer(w.asks[0]!);
    if (field === "options") a.options = [{ type: "buttons", buttons: [{ id: "sl_join_accept", label: "different recipient", style: "success" }] }];
    else a[field] = "different team, person or instance";
    await onJoinOfferAnswered(a, w.d);
    expect(w.joined).toEqual([]); expect(w.receipts).toEqual(["failed"]);
  }
});


test("restart orphan card closes and emits one failed receipt without recovering secrets", async () => {
  const w = world(), body = wire();
  await receiveJoinOffer(w.p, body, w.d);
  claimPendingOffer(w.dir, body.offerId); // Simulate the memory lost at restart, keeping the durable card.
  Object.assign(w.d, { listOrphanCandidates: () => w.asks, claimOrphan: (a: Ask) => { if (a.extra.joinOfferOrphanSettled) return false; a.extra.joinOfferOrphanSettled = true; return true; } });
  w.d.closeAsk = id => { w.asks.find(a => a.id === id)!.state = "cancelled"; };
  await sweepJoinOffers(w.d);
  expect(w.asks[0]!.state).toBe("cancelled");
  expect(w.receipts).toEqual(["failed"]);
  await sweepJoinOffers(w.d);
  expect(w.receipts).toEqual(["failed"]);
  expect(w.joined).toEqual([]);
});
