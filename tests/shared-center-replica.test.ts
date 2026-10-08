/** N7X1 center replicas: landing (AC1), replay by sync only (AC3), progress push (AC5), non-N7 regression (AC6). */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { getTask } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { cardFileLocks } from "../src/lib/ledger-scheduler-lease-sync.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { SHARED_LEDGER_CAPABILITIES } from "../src/lib/shared-ledger-contract.js";
import { featureBaseDigest } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { parseSharedLedgerCommand } from "../src/lib/shared-ledger-contract-validation.js";
import { readSharedLedgerMirrors, updateSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { readSharedLedgerMode, sharedLedgerPushable, writeSharedLedgerCredential, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { sharedLedgerPlanningReason } from "../src/lib/shared-ledger-gate.js";
import { putCenterClaim, setCenterClaimState } from "../src/lib/shared-ledger-center-claims.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { centerReplicaBaseDigest, centerReplicaLocalId, REPLICA_REASONS } from "../src/lib/shared-ledger-center-replica.js";
import { CENTER, detailOf, fakeFeature, FEATURE_UUID, ledgerSnapshot, LOCAL_ID, node, replicaKit, SCRUB } from "./shared-center-kit.js";
import { mirrorEntry } from "./shared-ledger-mirror-fixture.test.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { await open?.close(); open = null; });
async function kit(opts?: Parameters<typeof replicaKit>[0]) { open = await replicaKit(opts); return open; }
const noCommands = (k: Kit) => expect(k.center.requests.filter((r) => r.method === "POST" && /^\/v1\/teams\/[^/]+\/commands/.test(r.path))).toEqual([]);

/** What start_node (N7X2) leaves behind: committed claim → card → local dag-bind. */
async function claimAndBind(k: Kit, key: string, taskId: string, globs: string[]) {
  const op = `bind-${key}`;
  await putCenterClaim({ op, body: { featureId: FEATURE_UUID, nodeKey: key, sourceTaskId: taskId }, digest: v2ObjectDigest(op),
    localFeatureId: LOCAL_ID, key, taskId, state: "pending" }, k.dir);
  await setCenterClaimState(op, "committed", k.dir);
  createTask(k.f.db, { actor: k.f.actor }, { project: k.f.project, id: taskId, title: `卡 ${key}`, kind: "code",
    extra: { sharedFeatureId: LOCAL_ID, fileGlobs: globs } });
  expect(await k.f.ledger(["dag-bind", LOCAL_ID, key, taskId, "--rev", String(getFeature(k.f.db, LOCAL_ID)!.rev)])).toMatchObject({ ok: true });
}

test("AC1 sync lands a home-published N7 feature: center version, verbatim nodes, no UI node, digest from the detail, mirror entry on", async () => {
  const k = await kit();
  const center = fakeFeature();
  k.center.publish(center);
  expect(await k.sync()).toMatchObject({ ok: true, features: [{ centerFeatureId: FEATURE_UUID, result: "created", localFeatureId: LOCAL_ID, version: 2 }] });
  const f = getFeature(k.f.db, LOCAL_ID)!;
  expect(f).toMatchObject({ project: k.f.project, title: center.title, currentVersion: 2, status: "active" });
  const nodes = effectiveNodes(k.f.db, getDagVersion(k.f.db, LOCAL_ID, 2)!);
  expect(nodes.map(({ key, oneLine, deps, fileGlobs, estimate }) => ({ key, oneLine, deps, fileGlobs, estimate }))).toEqual(center.nodes);
  expect(nodes.map((n) => n.key)).toEqual(["alpha", "beta"]); // no local UI acceptance node
  expect(readSharedLedgerMode(LOCAL_ID)).toEqual({ authorityMode: "planning", sharedPlanning: true,
    centerPlanned: { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId, centerFeatureId: FEATURE_UUID } });
  // baseDigest = the contract's featureBaseDigest of the center detail, computed here from the same fake detail.
  const expectedDigest = featureBaseDigest({ feature: detailOf(center).feature, dag: detailOf(center).dag });
  expect(centerReplicaBaseDigest(detailOf(center))).toBe(expectedDigest);
  expect([centerReplicaLocalId(FEATURE_UUID), centerReplicaLocalId("not-a-uuid")]).toEqual([LOCAL_ID, null]);
  expect(readCenterReplicas().replicas[FEATURE_UUID]).toMatchObject({ localFeatureId: LOCAL_ID, version: 2, rev: 5, baseDigest: expectedDigest, lastError: null });
  expect(readSharedLedgerMirrors()[LOCAL_ID]).toMatchObject({ enabled: true, centerFeatureId: FEATURE_UUID, sourceInstanceId: CENTER.instanceId, localProject: k.f.project });
  expect(await k.status()).toMatchObject({ ok: true, replicas: [{ centerFeatureId: FEATURE_UUID, baseDigest: expectedDigest, mode: "planning" }] });
  // A second sync of the same center version changes nothing.
  const before = ledgerSnapshot(k.f.db);
  expect(await k.sync()).toMatchObject({ features: [{ result: "unchanged", version: 2 }] });
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
  noCommands(k);
});

test("AC1 sync needs the project's PM / master / owner", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  expect(await k.f.ledger(["center-replica", "sync"], "agent-stranger")).toMatchObject({ ok: false, code: "forbidden" });
  expect(k.center.requests).toEqual([]);
});

test("AC1 negatives: other home, kind=revise, V1 import, non-planning feature → zero write", async () => {
  const k = await kit();
  const before = ledgerSnapshot(k.f.db);
  k.center.publish(fakeFeature({ id: "11111111-2222-4333-8444-555555555555", homeInstanceId: "home-b" }));
  k.center.publish(fakeFeature({ id: "22222222-2222-4333-8444-555555555555", title: "修订提案" }), "revise");
  k.center.publish(fakeFeature({ id: "33333333-2222-4333-8444-555555555555", title: "V1 导入", authorityMode: "source" }), "none");
  k.center.publish(fakeFeature({ id: "44444444-2222-4333-8444-555555555555", title: "非规划", authorityMode: "source" }));
  const out = await k.sync();
  expect(out.features).toEqual([
    { centerFeatureId: "11111111-2222-4333-8444-555555555555", result: "skipped", reason: REPLICA_REASONS.notHome },
    { centerFeatureId: "44444444-2222-4333-8444-555555555555", result: "skipped", reason: REPLICA_REASONS.notPlanned },
  ]);
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
  expect(readCenterReplicas().replicas).toEqual({});
  noCommands(k);
});

test("AC1 negatives: content over the local limits is refused before any write, status shows the fixed reason", async () => {
  const cases: [Partial<ReturnType<typeof fakeFeature>>, string][] = [
    [{ title: "长".repeat(61) }, REPLICA_REASONS.title],
    [{ nodes: [node("alpha", { oneLine: "句".repeat(61) })] }, REPLICA_REASONS.oneLine],
    [{ nodes: [node("a:b", { fileGlobs: ["src/n7x/ab.ts"] })] }, REPLICA_REASONS.key],
    [{ nodes: [node("k".repeat(41))] }, REPLICA_REASONS.key],
    [{ nodes: [node("alpha", { fileGlobs: Array.from({ length: 51 }, (_, i) => `src/n7x/f${i}.ts`) })] }, REPLICA_REASONS.globs],
    [{ nodes: [node("alpha", { estimate: "估".repeat(21) })] }, REPLICA_REASONS.estimate],
  ];
  for (const [patch, reason] of cases) {
    const k = await kit();
    try {
      const before = ledgerSnapshot(k.f.db);
      k.center.publish(fakeFeature(patch));
      expect((await k.sync()).features).toEqual([{ centerFeatureId: FEATURE_UUID, result: "refused", reason }]);
      expect(ledgerSnapshot(k.f.db)).toEqual(before);
      expect(await k.status()).toMatchObject({ replicas: [], refused: [{ centerFeatureId: FEATURE_UUID, reason }] });
    } finally { await k.close(); open = null; }
  }
});

test("AC1 negatives: invalid credential, missing credential, unreachable center → zero write, fixed scope error", async () => {
  for (const [setup, reason] of [
    [(k: Kit) => { k.center.state.mode = "unauthorized"; }, REPLICA_REASONS.credentialRejected],
    [(k: Kit) => { k.center.state.mode = "down"; }, REPLICA_REASONS.unreachable],
    [async (k: Kit) => { k.center.stop(); }, REPLICA_REASONS.unreachable],
  ] as const) {
    const k = await kit();
    try {
      k.center.publish(fakeFeature());
      const before = ledgerSnapshot(k.f.db);
      await setup(k);
      expect(await k.sync()).toMatchObject({ ok: true, features: [], scopes: [{ error: reason }] });
      expect(ledgerSnapshot(k.f.db)).toEqual(before);
      expect(await k.status()).toMatchObject({ replicas: [], scopes: [{ lastError: reason }] });
    } finally { await k.close(); open = null; }
  }
  const k = await kit({ actions: ["read", "plan"] });
  k.center.publish(fakeFeature());
  const before = ledgerSnapshot(k.f.db);
  expect(await k.sync()).toMatchObject({ features: [], scopes: [{ error: REPLICA_REASONS.noCredential }] });
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
  expect(k.center.requests).toEqual([]);
});

test("AC1 a local feature already holding the replica id is not overwritten", async () => {
  const k = await kit();
  k.f.db.prepare("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) VALUES (?, ?, '本机同名', '', 'active', 0, 1, 'x', 1, 1)")
    .run(LOCAL_ID, k.f.project);
  const before = ledgerSnapshot(k.f.db);
  k.center.publish(fakeFeature());
  expect((await k.sync()).features).toEqual([{ centerFeatureId: FEATURE_UUID, result: "refused", reason: REPLICA_REASONS.idTaken }]);
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
});

test("AC3 only sync replays the center's v+1: bound card stays on the feature, fileGlobs and locks unchanged", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  await k.sync();
  await claimAndBind(k, "alpha", "n7x-alpha", ["src/n7x/alpha.ts"]);
  const card = getTask(k.f.db, "n7x-alpha")!, locks = cardFileLocks(k.f.db, "n7x-alpha");
  expect(card.featureId).toBe(LOCAL_ID);
  // Center bound alpha too (N7X2), then published v3 with a new node; the center id of the card is its own.
  const next = fakeFeature({ version: 3, rev: 7, bindings: [{ nodeKey: "alpha", taskId: "center-task-1" }],
    nodes: [node("alpha"), node("beta", { deps: ["alpha"] }), node("gamma", { deps: ["beta"] })] });
  k.center.publish(next, "none");
  expect(await k.sync()).toMatchObject({ features: [{ result: "replayed", version: 3 }] });
  const f = getFeature(k.f.db, LOCAL_ID)!;
  expect(f.currentVersion).toBe(3);
  const nodes = effectiveNodes(k.f.db, getDagVersion(k.f.db, LOCAL_ID, 3)!);
  expect(nodes.map((n) => [n.key, n.taskId])).toEqual([["alpha", "n7x-alpha"], ["beta", null], ["gamma", null]]);
  expect(getTask(k.f.db, "n7x-alpha")).toMatchObject({ featureId: LOCAL_ID, extra: { fileGlobs: ["src/n7x/alpha.ts"] } });
  expect(cardFileLocks(k.f.db, "n7x-alpha")).toEqual(locks);
  expect(readCenterReplicas().replicas[FEATURE_UUID]).toMatchObject({ version: 3, rev: 7,
    baseDigest: featureBaseDigest({ feature: detailOf(next).feature, dag: detailOf(next).dag }) });
  // The local rewrite path stays closed after the replay.
  expect(await k.f.ledger(["dag-rewrite", LOCAL_ID, "--rev", String(f.rev), "--nodes", JSON.stringify([{ key: "alpha" }]),
    "--reason-kind", "new_issue", "--reason", "本机改图"])).toMatchObject({ ok: false, code: "forbidden" });
  noCommands(k);
});

test("AC3 a center version that dropped or lost a locally bound node is not replayed", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  await k.sync();
  await claimAndBind(k, "alpha", "n7x-alpha", ["src/n7x/alpha.ts"]);
  const before = ledgerSnapshot(k.f.db);
  k.center.publish(fakeFeature({ version: 3, rev: 7, nodes: [node("beta")] }), "none");
  expect(await k.sync()).toMatchObject({ features: [{ result: "failed" }] });
  k.center.publish(fakeFeature({ version: 3, rev: 7 }), "none"); // alpha present but the center has no binding for it
  expect(await k.sync()).toMatchObject({ features: [{ result: "failed", reason: "中心没有本机已绑节点的绑定" }] });
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
  expect(readCenterReplicas().replicas[FEATURE_UUID]).toMatchObject({ version: 2, lastError: "中心没有本机已绑节点的绑定" });
});

test("AC5 the replica is pushed: center feature id, this instance, only bound cards; an instance mismatch is a fixed error", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  await k.sync();
  await claimAndBind(k, "alpha", "n7x-alpha", ["src/n7x/alpha.ts"]);
  createTask(k.f.db, { actor: k.f.actor }, { project: k.f.project, id: "n7x-unbound", title: "无关卡", kind: "code" });
  const out = await runSharedLedgerMirrorPass({ ledgerPath: k.f.db.filename, now: () => 50_000, scrub: async () => SCRUB });
  expect(out[LOCAL_ID]).toMatchObject({ kind: "pushed", mode: "snapshot" });
  expect(k.center.projections).toHaveLength(1);
  const sent = k.center.projections[0]!;
  expect(sent).toMatchObject({ featureId: FEATURE_UUID, sourceInstanceId: CENTER.instanceId, projectId: CENTER.projectId });
  expect(sent.tasks.map((t) => t.sourceTaskId)).toEqual(["n7x-alpha"]);
  // The credential now names another instance: nothing is sent, the error is the loop's fixed text.
  await writeSharedLedgerCredential({ localSubject: "owner:self", kind: "service", centerId: CENTER.centerId, baseUrl: k.center.url,
    teamId: CENTER.teamId, personId: CENTER.personId, instanceId: "home-b", bearer: "bearer-for-tests-only",
    projects: [{ projectId: CENTER.projectId, actions: ["project"] }] });
  createTask(k.f.db, { actor: k.f.actor }, { project: k.f.project, id: "n7x-later", title: "推进全局 seq", kind: "code" });
  const again = await runSharedLedgerMirrorPass({ ledgerPath: k.f.db.filename, now: () => 60_000, scrub: async () => SCRUB });
  expect(again[LOCAL_ID]).toEqual({ kind: "failed", error: "本机 service 凭据或实例密钥不可用" });
  expect(readSharedLedgerMirrors()[LOCAL_ID]).toMatchObject({ lastError: "本机 service 凭据或实例密钥不可用", failures: 1 });
  expect(k.center.projections).toHaveLength(1);
  noCommands(k);
});

test("AC6 non-N7 regression: activated planning feature is not pushed and cannot start; source mirror still pushes", async () => {
  const k = await kit();
  const f = k.f;
  await f.mode(true); // activated import: {planning, sharedPlanning} without centerPlanned
  await updateSharedLedgerMirrors(k.dir, (m) => { m[f.id] = mirrorEntry(f, 0); });
  createTask(f.db, { actor: f.actor }, { project: f.project, id: "n7x-seq", title: "推进 seq", kind: "code" });
  expect(await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, scrub: async () => SCRUB })).toEqual({});
  expect(sharedLedgerPushable(readSharedLedgerMode(f.id))).toBe(false);
  expect(sharedLedgerPlanningReason(f.id)).toBe(`feature ${f.id} 已迁入共享规划：本机不能改图、绑卡或开新节点，请在团队规划页操作；已有卡继续原授权流程`);
  const start = await f.tools.start_node(f.call, { featureId: f.id, key: "next", spec: "# x\n模板：code\n" });
  expect(start).toMatchObject({ ok: false, code: "forbidden", error: sharedLedgerPlanningReason(f.id) });
  // Source mirror (PJ1) keeps pushing exactly as before.
  await writeSharedLedgerMode(f.id, { authorityMode: "source", sharedPlanning: true, mirror: true }, k.dir, f.db.filename);
  const sent: unknown[] = [];
  const out = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 1, scrub: async () => SCRUB,
    client: () => ({ async projection(p) { sent.push(p); return { schemaVersion: 1, serverSeq: 1, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "b".repeat(64) }; } }) });
  expect(out[f.id]).toMatchObject({ kind: "pushed" });
  expect(sent).toHaveLength(1);
});

test("AC6 V1 capabilities unchanged: dag.bind stays disabled and a dag.bind command is still rejected", () => {
  expect(SHARED_LEDGER_CAPABILITIES["dag.bind"]).toEqual({ enabled: false, code: "execution_not_shared", reason: "V1 不允许共享绑卡，已绑节点原样保留" });
  expect(() => parseSharedLedgerCommand({ type: "dag.bind", requestId: "r", projectId: "p", featureId: "f", expectedRev: 1, nodeKey: "a", taskId: "t" })).toThrow();
});

test("AC6 mode file: entries without centerPlanned still read; a malformed centerPlanned fails closed", async () => {
  const k = await kit();
  const path = join(k.dir, "shared-ledger-modes.json");
  const old = { "old-a": { authorityMode: "planning", sharedPlanning: true }, "old-b": { authorityMode: "source", sharedPlanning: true, mirror: true } };
  writeFileSync(path, JSON.stringify({ features: old }), { mode: 0o600 });
  expect(readSharedLedgerMode("old-a")).toEqual({ authorityMode: "planning", sharedPlanning: true });
  expect(readSharedLedgerMode("old-b")).toEqual({ authorityMode: "source", sharedPlanning: true, mirror: true });
  for (const bad of [{ authorityMode: "source", sharedPlanning: false, centerPlanned: { centerId: "c", teamId: "t", projectId: "p", centerFeatureId: "f" } },
    { authorityMode: "planning", sharedPlanning: true, centerPlanned: { centerId: "c", teamId: "t", projectId: "p" } }]) {
    writeFileSync(path, JSON.stringify({ features: { [LOCAL_ID]: bad } }), { mode: 0o600 });
    expect(() => readSharedLedgerMode(LOCAL_ID)).toThrow("shared ledger local state invalid");
    expect(sharedLedgerPlanningReason(LOCAL_ID)).toContain("无法核验");
  }
  writeFileSync(path, JSON.stringify({ features: {} }), { mode: 0o600 });
});
