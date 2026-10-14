/** team-project-TEAMVIS12: reviewer / PM identity on the body upload — where it comes from, what goes, and the fallback. */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { storedOrigin } from "../src/lib/ledger-origin.js";
import type { TeamBodyRecord, TeamBodyUpload } from "../src/lib/shared-ledger-contract-team-body.js";
import { readTeamBodySync } from "../src/lib/team-body-sync.js";
import type { TeamBodySpecMeta } from "../src/lib/team-body-roles-contract.js";
import { identityKey, rolePeers, withRoles, type RolePeer, type RoleSource } from "../src/lib/team-body-roles.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { world } from "./team-body-sync-fixture.test.js";

const TASK = "c5-existing";
const HOME = "home-a"; // the fixture's service credential instanceId
const T0 = 1_790_000_000_000;
const DAY = 24 * 60 * 60_000;
type World = Awaited<ReturnType<typeof world>>;

const PEERS: RolePeer[] = [
  { name: "hede", instanceId: "peer-inst-1" },
  { name: "off", instanceId: "peer-inst-2", disabled: true },
  { name: "noid" },
  { name: "bad", instanceId: "_not-an-id" }, // passes isInstanceId, fails the contract's id: the key is dropped
];
/** A peers reader that counts its calls. */
function peers(list: RolePeer[] = PEERS) {
  const seen = { calls: 0 };
  return { seen, read: async () => { seen.calls++; return list; } };
}
/** The pass with peers injected (TeamBodySyncDeps.peers rides the mirror loop's deps through). */
function passWith(w: World, read: () => Promise<RolePeer[]>) {
  const deps = { ...w.deps(), peers: read };
  return runSharedLedgerMirrorPass(deps);
}

function review(w: World, actor: string, data: Record<string, unknown> = {}, origin: string | null = null): number {
  return Number(w.f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data, origin) VALUES (?, ?, ?, ?, 'review', '', ?, ?)")
    .run(T0, actor, w.f.project, TASK, JSON.stringify({ verdict: "pass", p0: 0, p1: 0, p2: 0, ...data }), origin).lastInsertRowid);
}
function note(w: World, text: string): number {
  return Number(w.f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-dev', ?, ?, 'note', ?, '{}')")
    .run(T0 + 1, w.f.project, TASK, text).lastInsertRowid);
}
function spec(w: World, pm: string | null, rev = 1) {
  w.f.db.prepare("UPDATE tasks SET pm = ?, specRev = ? WHERE id = ?").run(pm, rev, TASK);
  writeFileSync(join(w.docs, "tasks", `${TASK}.md`), `# 规格 ${rev}`);
}
const sent = (w: World): TeamBodyRecord[] => w.uploads().flatMap((u) => u.records);
const reviewerOf = (w: World, seq: number) => sent(w).filter((r) => r.kind === "review" && r.sourceKey === String(seq)).map((r) => r.meta?.reviewer);
/** Identity refused (TEAMVIS9 / TEAMVIS11 center): reviewer on a review, or any spec meta → 400. */
const refusesIdentity = (w: World, seen = { refused: 0 }) => w.failing((u: TeamBodyUpload) => {
  if (!u.records.some((r) => r.meta?.reviewer || (r.kind === "spec" && r.meta))) return null;
  seen.refused++;
  return Response.json({ schemaVersion: 1, code: "invalid_field", status: 400, message: "invalid" }, { status: 400 });
});

test("[验收线 2] reviewer: local agent / owner / PM writing for a local reviewer → this instance; peer: → that peer; the rest none; every review still goes up", async () => {
  const w = await world("on");
  try {
    const local = storedOrigin(w.f.db);
    const p = peers();
    const s = {
      agent: review(w, "agent-rev"), owner: review(w, "owner"), pmLocal: review(w, "agent-pm", { reviewer: "agent-rev" }),
      sameOrigin: review(w, "agent-rev", {}, local),
      peerActor: review(w, "peer:hede"), pmForPeer: review(w, "agent-pm", { reviewer: "peer:hede" }),
      gone: review(w, "peer:gone"), disabled: review(w, "peer:off"), noId: review(w, "peer:noid"), badId: review(w, "peer:bad"),
      imported: review(w, "agent-rev", { imported: true }), importActor: review(w, "import"), foreign: review(w, "agent-rev", {}, "zz9z"),
      at: review(w, "agent-rev@hede"), atData: review(w, "agent-pm", { reviewer: "rev@hede" }),
    };
    await passWith(w, p.read);
    const expected: Record<keyof typeof s, string | undefined> = {
      agent: HOME, owner: HOME, pmLocal: HOME, sameOrigin: local ? HOME : undefined, peerActor: "peer-inst-1", pmForPeer: "peer-inst-1",
      gone: undefined, disabled: undefined, noId: undefined, badId: undefined, imported: undefined, importActor: undefined, foreign: undefined,
      at: undefined, atData: undefined,
    };
    for (const [k, seq] of Object.entries(s)) {
      const want = expected[k as keyof typeof s];
      expect([k, reviewerOf(w, seq)]).toEqual([k, [want === undefined ? undefined : { instanceId: want }]]);
    }
    expect(sent(w).filter((r) => r.kind === "review").every((r) => r.meta?.kind === "review" && r.meta.ts === T0)).toBe(true);
    expect(readTeamBodySync(w.dir).features[w.f.id]).toMatchObject({ refusedTotal: 0, failures: 0 });
    expect(p.seen.calls).toBe(1);
  } finally { await w.f.close(); }
});

test("[验收线 2] PM: tasks.pm local → this instance, peer: → that peer, empty / x@y / unknown peer → the spec goes without meta", async () => {
  const items = (pm: string | null): { kind: "spec"; who: RoleSource; meta?: TeamBodySpecMeta }[] => [{ kind: "spec", who: { pm } }];
  const ctx = (read = peers().read) => ({ localInstance: HOME, storedOrigin: null, peers: rolePeers(read) });
  expect((await withRoles(items("agent-pm"), ctx()))[0]!.meta).toEqual({ pm: { instanceId: HOME } });
  expect((await withRoles(items("peer:hede"), ctx()))[0]!.meta).toEqual({ pm: { instanceId: "peer-inst-1" } });
  for (const pm of [null, "", "pm@hede", "peer:gone", "peer:off", "peer:bad"]) expect((await withRoles(items(pm), ctx()))[0]!.meta).toBeUndefined();
  // A local instance id the contract would not carry: dropped, never the record.
  expect((await withRoles(items("agent-pm"), { ...ctx(), localInstance: "_bad" }))[0]).toEqual(items("agent-pm")[0]!);
  // A failing peers reader reads as no peers.
  expect((await withRoles(items("peer:hede"), ctx(async () => { throw new Error("broken"); })))[0]!.meta).toBeUndefined();
  // A review without its event meta (meta not carried this pass) gets no reviewer.
  const bare = { kind: "review" as const, who: { actor: "agent-rev", origin: null, data: "{}" } };
  expect(await withRoles([bare], ctx())).toEqual([bare]);

  const w = await world("on");
  try {
    spec(w, "agent-pm");
    await passWith(w, peers().read);
    expect(sent(w).filter((r) => r.kind === "spec").map((r) => r.meta)).toEqual([{ pm: { instanceId: HOME } }]);
    spec(w, null, 2);
    await passWith(w, peers().read);
    const second = sent(w).filter((r) => r.kind === "spec" && r.sourceKey === "2");
    expect(second).toHaveLength(1);
    expect(Object.hasOwn(second[0]!, "meta")).toBe(false);
  } finally { await w.f.close(); }
});

test("[验收线 3] a center that takes identity: instanceId only, no memberCode, only probe and upload requests, event records as TEAMVIS10", async () => {
  const w = await world("on");
  try {
    const p = peers();
    const n = note(w, "补了用例"), r = review(w, "agent-rev"), q = review(w, "peer:hede");
    spec(w, "peer:hede");
    await passWith(w, p.read);
    expect(sent(w).map((x) => [x.kind, x.sourceKey, x.meta])).toEqual([
      ["event", String(n), { kind: "note", ts: T0 + 1 }],
      ["review", String(r), { kind: "review", ts: T0, reviewer: { instanceId: HOME } }],
      ["review", String(q), { kind: "review", ts: T0, reviewer: { instanceId: "peer-inst-1" } }],
      ["spec", "1", { pm: { instanceId: "peer-inst-1" } }],
    ]);
    expect(JSON.stringify(w.requests)).not.toContain("memberCode");
    expect(w.requests.map((x) => [x.method, x.path])).toEqual([
      ["GET", "/v1/teams/team-a/team-body/capability"], ["POST", "/v1/teams/team-a/team-body/batches"]]);
    expect(p.seen.calls).toBe(1);
    expect(readTeamBodySync(w.dir).metaRefused).toBeUndefined();
  } finally { await w.f.close(); }
});

test("[验收线 4] a center that refuses identity: the same batch again without it (kind / ts kept), `identity:` marked 24 h, the origin key not; then as TEAMVIS10; identity again after", async () => {
  const w = await world("on");
  try {
    const seen = { refused: 0 };
    refusesIdentity(w, seen);
    const n = note(w, "一"), r = review(w, "agent-rev");
    spec(w, "agent-pm");
    await passWith(w, peers().read);
    expect(seen.refused).toBe(1);
    const [first, retry, ...rest] = w.uploads();
    expect(rest).toHaveLength(0);
    expect(first!.records.map((x) => x.meta)).toEqual([{ kind: "note", ts: T0 + 1 }, { kind: "review", ts: T0, reviewer: { instanceId: HOME } }, { pm: { instanceId: HOME } }]);
    expect(retry!.records.map((x) => x.meta)).toEqual([{ kind: "note", ts: T0 + 1 }, { kind: "review", ts: T0 }, undefined]);
    expect(Object.hasOwn(retry!.records[2]!, "meta")).toBe(false);
    const file = readTeamBodySync(w.dir), keys = Object.keys(file.metaRefused ?? {});
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith("identity:")).toBe(true);
    expect(file.metaRefused![keys[0]!]).toBe(w.now() + DAY);
    expect(file.features[w.f.id]).toMatchObject({ eventSeq: r, metaSeq: r, failures: 0, refusedTotal: 0 });

    // Within the day: no identity tried, no 400, peers never read; the request is TEAMVIS10's, word for word.
    const p = peers();
    const m = review(w, "agent-rev");
    spec(w, "agent-pm", 2);
    w.advance(DAY - 60_000);
    await passWith(w, p.read);
    expect(seen.refused).toBe(1);
    expect(p.seen.calls).toBe(0);
    const quiet = w.uploads().slice(2).map(({ batchId: _b, ...u }) => u);
    expect(quiet).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(quiet[0]!.records.map(({ digest: _d, text: _t, ...x }) => x)))).toEqual([
      { featureId: "center-feature-1", taskId: TASK, kind: "review", sourceKey: String(m), scrubVersion: quiet[0]!.records[0]!.scrubVersion, maskedSegments: 0, meta: { kind: "review", ts: T0 } },
      { featureId: "center-feature-1", taskId: TASK, kind: "spec", sourceKey: "2", scrubVersion: quiet[0]!.records[1]!.scrubVersion, maskedSegments: 0 },
    ]);
    expect(n).toBeLessThan(r);

    // The mark runs out and the center now takes identity.
    w.failing(false);
    const later = review(w, "agent-rev");
    w.advance(DAY);
    await passWith(w, peers().read);
    expect(reviewerOf(w, later)).toEqual([{ instanceId: HOME }]);
  } finally { await w.f.close(); }
});

test("[验收线 4] an older center (any meta → 400): falls to TEAMVIS10's no-meta state, the body goes up, no failure, no backoff, no identity mark", async () => {
  const w = await world("on");
  try {
    w.failing((u) => u.records.some((r) => r.meta) ? Response.json({ schemaVersion: 1, code: "invalid_field", status: 400, message: "invalid" }, { status: 400 }) : null);
    const n = note(w, "一"), r = review(w, "agent-rev");
    spec(w, "agent-pm");
    const p = peers();
    await passWith(w, p.read);
    expect(p.seen.calls).toBe(0); // no `peer:` source this pass: peers.json not read
    const ups = w.uploads();
    expect(ups).toHaveLength(3);
    expect(ups[2]!.records.every((x) => !Object.hasOwn(x, "meta"))).toBe(true);
    expect(ups[2]!.records.map((x) => x.sourceKey)).toEqual([String(n), String(r), "1"]);
    const file = readTeamBodySync(w.dir);
    expect(Object.keys(file.metaRefused ?? {}).some((k) => k.startsWith("identity:"))).toBe(false);
    expect(Object.keys(file.metaRefused ?? {})).toHaveLength(1);
    expect(file.features[w.f.id]).toMatchObject({ eventSeq: r, failures: 0, nextAttemptAt: 0, refusedTotal: 0 });
  } finally { await w.f.close(); }
});

test("[验收线 5] observe / off / capability false: peers never read, no identity", async () => {
  for (const mode of ["observe", "off"] as const) {
    const w = await world(mode);
    try {
      const p = peers();
      review(w, "peer:hede");
      spec(w, "peer:hede");
      await passWith(w, p.read);
      expect(p.seen.calls).toBe(0);
      expect(w.requests).toHaveLength(0);
    } finally { await w.f.close(); }
  }
  const w = await world("on");
  try {
    w.setCapability(() => Response.json({ schemaVersion: 1, teamId: "team-a", teamBody: false }));
    const p = peers();
    review(w, "peer:hede");
    await passWith(w, p.read);
    expect(p.seen.calls).toBe(0);
    expect(w.uploads()).toHaveLength(0);
  } finally { await w.f.close(); }
});

test("identityKey keeps the origin key free, so meta still goes while identity is refused", () => {
  expect(identityKey("abc")).toBe("identity:abc");
});
