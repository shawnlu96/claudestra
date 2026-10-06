import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Ask } from "../src/lib/ledger-asks.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { parseJoinOffer, joinOfferCard } from "../src/lib/shared-ledger-join-offer.js";
import { receiveJoinOffer, onJoinOfferAnswered, setSharedProjectAuditHook, sweepJoinOfferMaintenance, type JoinOfferDeps } from "../src/bridge/shared-ledger-join-offer.js";
import { projectChoices } from "../src/bridge/local-api/shared-projects-choice.js";
import { inviteSharedProject } from "../src/bridge/local-api/shared-projects-invite.js";

const centerId = "center-" + "c".repeat(32);
const code = `sljoin1.${centerId}.${"a".repeat(32)}.${"M".repeat(43)}`;
const project = { teamId: "team", projectId: "project-b", name: "Project B" };
const roots: string[] = [];
afterEach(() => { setSharedProjectAuditHook(undefined); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), "n4-join-")); roots.push(r); return r; };
const peer = (): HttpPeer => ({ name: `peer-${randomBytes(4).toString("hex")}`, baseUrl: "https://peer.example", outToken: "synthetic-token", addedAt: "" });
const wire = () => ({ v: 1, offerId: randomBytes(16).toString("hex"), url: "https://center.example/", code, project });
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
  expect(w.joined).toEqual([{ selection: { mode: "create" }, expected: { ...project, centerId } }]);
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

test("N3 code is only present in peer POST; sender files, logs and public result never contain secrets", async () => {
  const dir = root(), p = peer(), bodies: string[] = [], logs: unknown[] = [];
  const spies = (["log", "warn", "error"] as const).map(m => spyOn(console, m).mockImplementation((...args) => { logs.push(args); }));
  try {
    const result = await inviteSharedProject({ subject: "owner:self", kind: "person", centerId, teamId: "team", personId: "alice", instanceId: "instance" },
      "project-b", [p.name], "welcome", { now: () => Date.now(), stateDir: dir, peers: async () => [p], receiptProject: "local-a",
        mint: async () => ({ code, url: "https://center.example/", project, expiresAt: Date.now() + 60000 }),
        post: async (_peer, _url, body) => { bodies.push(body); return new Response("SECRET_RESPONSE", { status: 202 }); } });
    expect(result[0]!.accepted).toBe(true);
    expect(JSON.parse(bodies[0]!).code).toBe(code); expect(JSON.parse(bodies[0]!).project).toEqual(project);
    const files = readdirSync(join(dir, "shared-ledger-join-offers-sent")).map(f => readFileSync(join(dir, "shared-ledger-join-offers-sent", f), "utf8"));
    const publicData = JSON.stringify([files, logs, result]);
    for (const secret of [code, "M".repeat(43), "SECRET_RESPONSE"]) expect(publicData).not.toContain(secret);
  } finally { spies.forEach(s => s.mockRestore()); }
});

test("plaintext or unconfigured peers are rejected before minting", async () => {
  const p = peer(); p.baseUrl = "http://peer.example";
  let minted = false;
  await expect(inviteSharedProject({ subject: "owner:self", kind: "person", centerId, teamId: "team", personId: "alice", instanceId: "instance" },
    "project-b", [p.name], undefined, { now: () => Date.now(), stateDir: root(), peers: async () => [p], receiptProject: "local-a",
      mint: async () => { minted = true; throw new Error("must not run"); }, post: async () => { throw new Error("must not run"); } })).rejects.toThrow();
  expect(minted).toBe(false);
});
