/** N7X3 rewriting a center replica → kind=revise proposal: three entries (AC1), local refusals (AC2), offline / resend / drift (AC3),
 * replay after publish (AC4), progress-only center changes are no drift (AC5), title / bindings-only changes are drift (PM 补 16:5x).
 * The fake center is the N7X1 kit (replica sync) plus an in-process proposal route and detail override on the injected fetch.
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createTask } from "../src/lib/ledger-write.js";
import { putCenterClaim, setCenterClaimState } from "../src/lib/shared-ledger-center-claims.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import {
  featureBaseDigest, featureProposalError, proposalDigest, type FeatureProposal, type FeatureProposalRevise,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { createFeatureProposalFixtures, FEATURE_PROPOSAL_FIXTURE_DIGESTS } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import type { SharedLedgerFeatureDetail } from "../src/lib/shared-ledger-contract.js";
import { centerReplicaBaseDigest } from "../src/lib/shared-ledger-center-replica.js";
import { configureCenterRevise, REVISE_TEXT } from "../src/lib/shared-ledger-center-revise.js";
import { readPendingProposals, resumeProposals, type ProposalRuntime } from "../src/lib/shared-ledger-feature-proposals-store.js";
import { CENTER, detailOf, fakeFeature, FEATURE_UUID, ledgerSnapshot, LOCAL_ID, node, replicaKit, type FakeFeature } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
const SCOPE = { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId };

/** Proposal routes and detail overrides of the fake center; everything else goes to the kit's server. */
function proposalCenter(k: Kit) {
  const records = new Map<string, { proposal: FeatureProposal; operation: Record<string, unknown> }>();
  const c = {
    received: [] as FeatureProposal[], calls: [] as string[], down: false,
    /** Applied to the V1 detail the center serves (progress fields, title, bindings, …). */
    patch: null as ((d: SharedLedgerFeatureDetail) => void) | null,
    detail(): SharedLedgerFeatureDetail { const d = detailOf(k.center.features.get(FEATURE_UUID)!); c.patch?.(d); return d; },
    publish(f: FakeFeature) { k.center.publish(f, "none"); },
    fetch: (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input)), method = init.method ?? "GET";
      c.calls.push(`${method} ${url.pathname}`);
      if (url.pathname.startsWith("/v1/feature-proposals") && c.down) throw new TypeError("connect ECONNREFUSED");
      const reply = (r: { proposal: FeatureProposal; operation: Record<string, unknown> }) => {
        const drift = r.proposal.kind === "revise" && r.operation.state === "pending_approval"
          && r.proposal.baseDigest !== featureBaseDigest({ feature: c.detail().feature, dag: c.detail().dag });
        return Response.json({ proposal: r.proposal, proposalId: r.operation.proposalId, proposalRev: 1,
          proposer: { type: "service", personId: CENTER.personId, instanceId: CENTER.instanceId },
          operation: { ...r.operation, ...(drift ? { state: "conflict" } : {}) } });
      };
      if (method === "POST" && url.pathname === "/v1/feature-proposals") {
        const p = (JSON.parse(String(init.body)) as { payload: FeatureProposal }).payload;
        if (!records.has(p.operationId)) {
          c.received.push(p);
          records.set(p.operationId, { proposal: p, operation: { schemaVersion: 1, ...SCOPE, operationId: p.operationId, proposalDigest: proposalDigest(p),
            state: "pending_approval", proposalId: `proposal-${records.size + 1}`, featureId: null, version: null, updatedAt: 1000 } });
        }
        return reply(records.get(p.operationId)!);
      }
      const op = /^\/v1\/feature-proposals\/operations\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && op) return records.has(op[1]!) ? reply(records.get(op[1]!)!) : Response.json(featureProposalError("forbidden"), { status: 403 });
      if (method === "GET" && url.pathname === `/v1/teams/${CENTER.teamId}/features/${FEATURE_UUID}`) return Response.json(c.detail());
      return fetch(input, init);
    }) as typeof fetch,
  };
  return c;
}

let open: Kit | null = null;
/** The kit does not own the N7B journal: each test starts and ends without one. */
const dropJournal = () => rmSync(join(STATE_DIR, "shared-feature-proposals.json"), { force: true });
async function teardown() { configureCenterRevise(undefined); await open?.close(); open = null; dropJournal(); }
afterEach(teardown);
/** A synced replica of fakeFeature() (v2 / rev 5) and an owner:self service credential that may also plan. */
async function setup() {
  dropJournal();
  const k = open = await replicaKit({ actions: ["project", "plan"] });
  k.center.publish(fakeFeature());
  expect(await k.sync()).toMatchObject({ features: [{ result: "created", version: 2 }] });
  const center = proposalCenter(k);
  let n = 0;
  const rt: ProposalRuntime = { stateDir: k.dir, now: Date.now, newOperationId: () => `op-revise-${++n}`, ttlMs: 3_600_000,
    fetch: center.fetch, instanceId: () => CENTER.instanceId };
  configureCenterRevise(rt);
  return { k, f: k.f, center, rt };
}
const rev = (k: Kit) => String(getFeature(k.f.db, LOCAL_ID)!.rev);
const GAMMA = node("gamma", { deps: ["beta"] });
const nextNodes = [node("alpha"), node("beta", { deps: ["alpha"] }), GAMMA];
const cli = (k: Kit, nodes: unknown, more: string[] = []) => k.f.ledger(["dag-rewrite", LOCAL_ID, "--rev", rev(k), "--nodes", JSON.stringify(nodes),
  "--reason-kind", "new_issue", "--reason", "加 gamma 节点", ...more]);
/** What start_node (N7X2) leaves behind on alpha: committed claim → card → local dag-bind (as tests/shared-center-replica.test.ts). */
async function bindAlpha(k: Kit) {
  await putCenterClaim({ op: "bind-alpha", body: { featureId: FEATURE_UUID, nodeKey: "alpha", sourceTaskId: "n7x-alpha" }, digest: v2ObjectDigest("bind-alpha"),
    localFeatureId: LOCAL_ID, key: "alpha", taskId: "n7x-alpha", state: "pending" }, k.dir);
  await setCenterClaimState("bind-alpha", "committed", k.dir);
  createTask(k.f.db, { actor: k.f.actor }, { project: k.f.project, id: "n7x-alpha", title: "卡 alpha", kind: "code",
    extra: { sharedFeatureId: LOCAL_ID, fileGlobs: ["src/n7x/alpha.ts"] } });
  expect(await k.f.ledger(["dag-bind", LOCAL_ID, "alpha", "n7x-alpha", "--rev", rev(k)])).toMatchObject({ ok: true });
}

test("helper: centerReplicaBaseDigest is the contract featureBaseDigest (fixture digest)", () => {
  expect(centerReplicaBaseDigest(createFeatureProposalFixtures().baseDetail)).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.featureBase);
});

const entries: [string, (s: Awaited<ReturnType<typeof setup>>) => Promise<unknown>][] = [
  ["CLI dag-rewrite", (s) => cli(s.k, nextNodes)],
  ["rewrite_dag", (s) => s.f.tools.rewrite_dag!(s.f.call, { featureId: LOCAL_ID, reasonKind: "new_issue", reason: "加 gamma 节点", add: [GAMMA] })],
  ["plan_feature on the existing feature", (s) => s.f.tools.plan_feature!(s.f.call, { featureId: LOCAL_ID, reasonKind: "new_issue", reason: "加 gamma 节点", nodes: nextNodes })],
];
for (const [name, call] of entries) {
  test(`AC1 ${name} on a replica becomes one kind=revise proposal with the fresh center base; zero local ledger writes`, async () => {
    const s = await setup();
    // The center moved on (rev 6) after the last replica sync: the base is read fresh, not taken from the replica cache.
    s.center.publish(fakeFeature({ rev: 6 }));
    const before = ledgerSnapshot(s.f.db);
    const out = await call(s) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, applied: false, message: REVISE_TEXT.pending_approval, proposal: { kind: "revise", state: "pending_approval" } });
    expect(String(out.message)).toContain("待项目 owner 批准");
    expect(s.center.received).toHaveLength(1);
    const p = s.center.received[0] as FeatureProposalRevise;
    const fresh = s.center.detail();
    expect(p).toMatchObject({ ...SCOPE, kind: "revise", featureId: FEATURE_UUID, baseVersion: 2, expectedRev: 6, title: fresh.feature.title,
      homeInstanceId: CENTER.instanceId, ownerWords: "加 gamma 节点", baseDigest: featureBaseDigest({ feature: fresh.feature, dag: fresh.dag }) });
    // Only the five center fields per node (no taskId / status / local extras).
    expect(p.nodes.map((x) => x.key)).toEqual(["alpha", "beta", "gamma"]);
    for (const x of p.nodes) expect(Object.keys(x).sort()).toEqual(["deps", "estimate", "fileGlobs", "key", "oneLine"]);
    expect(ledgerSnapshot(s.f.db)).toEqual(before);
    expect(getFeature(s.f.db, LOCAL_ID)).toMatchObject({ currentVersion: 2, rev: 1 });
  });
}

test("AC2 changing / removing / cancelling a bound node, or scopeChange, is refused locally with zero requests", async () => {
  const s = await setup();
  await bindAlpha(s.k);
  const before = ledgerSnapshot(s.f.db), requests = s.k.center.requests.length;
  const cases: [Promise<unknown>, string][] = [
    [cli(s.k, [node("alpha", { oneLine: "改了已绑节点" }), node("beta", { deps: ["alpha"] })]), REVISE_TEXT.bound],
    [cli(s.k, [node("alpha", { fileGlobs: ["src/n7x/other.ts"] }), node("beta", { deps: ["alpha"] })]), REVISE_TEXT.bound],
    [cli(s.k, [node("beta")]), REVISE_TEXT.bound],
    [cli(s.k, [node("beta")], ["--cancel", JSON.stringify({ alpha: "不做了" })]), REVISE_TEXT.bound],
    [cli(s.k, nextNodes, ["--scope-change"]), REVISE_TEXT.scope],
    [s.f.tools.rewrite_dag!(s.f.call, { featureId: LOCAL_ID, reasonKind: "new_issue", reason: "x", add: [GAMMA], scopeChange: true }), REVISE_TEXT.scope],
  ];
  for (const [p, text] of cases) {
    const out = await p as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain(text);
  }
  expect(s.center.calls).toEqual([]);
  expect(s.k.center.requests.length).toBe(requests);
  expect(readPendingProposals(s.k.dir)).toEqual([]);
  expect(ledgerSnapshot(s.f.db)).toEqual(before);
  // Unchanged bound node + a new node is fine and goes out with alpha verbatim.
  expect(await cli(s.k, nextNodes)).toMatchObject({ ok: true, proposal: { kind: "revise" } });
  expect(s.center.received[0]!.nodes[0]).toEqual(node("alpha"));
});

test("AC3 center unreachable → pending-sync record; equal content reuses the operation, other content or base gets a new one", async () => {
  const s = await setup();
  const before = ledgerSnapshot(s.f.db);
  s.center.down = true;
  const first = await cli(s.k, nextNodes) as Record<string, any>;
  expect(first).toMatchObject({ ok: false, code: "pending_sync", proposal: { kind: "revise", state: "unsynced" } });
  expect(readPendingProposals(s.k.dir)).toMatchObject([{ operationId: "op-revise-1", state: "unsynced", issue: "unavailable", proposal: { kind: "revise" } }]);
  expect(await cli(s.k, nextNodes)).toMatchObject({ proposal: { operationId: "op-revise-1" } });
  s.center.down = false;
  expect(await cli(s.k, nextNodes)).toMatchObject({ ok: true, proposal: { operationId: "op-revise-1", state: "pending_approval" } });
  expect(s.center.received.map((p) => p.operationId)).toEqual(["op-revise-1"]);
  // Other content → new operation.
  expect(await cli(s.k, [...nextNodes, node("delta", { deps: ["gamma"] })])).toMatchObject({ ok: true, proposal: { operationId: "op-revise-2" } });
  // Same content, moved base (center title) → new operation.
  s.center.patch = (d) => { d.feature.title = "中心改了标题"; };
  expect(await cli(s.k, nextNodes)).toMatchObject({ proposal: { operationId: "op-revise-3" } });
  expect(ledgerSnapshot(s.f.db)).toEqual(before);
});

test("AC3 / PM 补: same rev, only title or only dag.bindings changed → featureBaseDigest moves, the proposal drifts and is not resent", async () => {
  for (const patch of [(d: SharedLedgerFeatureDetail) => { d.feature.title = "只改标题"; },
    (d: SharedLedgerFeatureDetail) => { d.dag.bindings = [{ nodeKey: "beta", taskId: "center-task-9" }]; }]) {
    const s = await setup();
    expect(await cli(s.k, nextNodes)).toMatchObject({ ok: true, proposal: { operationId: "op-revise-1" } });
    const base = s.center.detail(), digest = featureBaseDigest({ feature: base.feature, dag: base.dag });
    s.center.patch = patch;
    const moved = s.center.detail();
    expect(moved.feature.rev).toBe(base.feature.rev);
    expect(centerReplicaBaseDigest(moved)).not.toBe(digest);
    expect(await resumeProposals(s.rt)).toMatchObject([{ operationId: "op-revise-1", state: "pending_approval", issue: "drift" }]);
    expect(await resumeProposals(s.rt)).toMatchObject([{ issue: "drift" }]);
    expect(s.center.received).toHaveLength(1); // never resent
    await teardown();
  }
});

test("AC5 only counts / status / projection change → featureBaseDigest unchanged, the submitted revision is not drift", async () => {
  const s = await setup();
  expect(await cli(s.k, nextNodes)).toMatchObject({ ok: true });
  const before = centerReplicaBaseDigest(s.center.detail());
  s.center.patch = (d) => {
    d.feature.counts = { total: 2, completed: 1, blocked: 1, missing: 0 }; d.feature.status = "blocked";
    d.feature.updatedBy = "person-b"; d.feature.updatedAt = 5000; d.feature.executorInstanceIds = [CENTER.instanceId];
  };
  expect(centerReplicaBaseDigest(s.center.detail())).toBe(before);
  expect(await resumeProposals(s.rt)).toMatchObject([{ operationId: "op-revise-1", state: "pending_approval", issue: null }]);
  expect(s.center.received).toHaveLength(1);
});

test("AC4 after the center publishes the revision, the next replica sync replays the local copy to v+1", async () => {
  const s = await setup();
  expect(await cli(s.k, nextNodes)).toMatchObject({ ok: true });
  expect(getFeature(s.f.db, LOCAL_ID)!.currentVersion).toBe(2);
  const p = s.center.received[0] as FeatureProposalRevise;
  s.center.publish(fakeFeature({ version: p.baseVersion + 1, rev: p.expectedRev + 1, nodes: p.nodes }));
  expect(await s.k.sync()).toMatchObject({ features: [{ result: "replayed", version: 3 }] });
  expect(getFeature(s.f.db, LOCAL_ID)!.currentVersion).toBe(3);
  expect(getDagVersion(s.f.db, LOCAL_ID, 3)!.nodes.map((x) => x.key)).toEqual(["alpha", "beta", "gamma"]);
});

test("a feature that is not a center replica keeps the old local rewrite path", async () => {
  const s = await setup();
  const f = getFeature(s.f.db, s.f.id)!;
  const out = await s.f.ledger(["dag-rewrite", f.id, "--rev", String(f.rev), "--nodes", JSON.stringify(getDagVersion(s.f.db, f.id, f.currentVersion!)!.nodes),
    "--reason-kind", "new_issue", "--reason", "本机改"]);
  expect(out).not.toHaveProperty("proposal.kind");
  expect(s.center.calls).toEqual([]);
});
