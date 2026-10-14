/** REPLPULL1 background center-replica pull: on lands / replays (AC1 / AC2), observe logs only (AC3), skip reasons kept (AC4), no double write with the CLI (AC5). */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createTask } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, type RecoveryKey, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { putCenterClaim, setCenterClaimState } from "../src/lib/shared-ledger-center-claims.js";
import { readCenterReplicas, updateCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { REPLICA_REASONS, syncCenterReplicas } from "../src/lib/shared-ledger-center-replica.js";
import { REPLICA_ACTOR } from "../src/lib/shared-ledger-center-replica-write.js";
import { CENTER_REPLICA_PULL_INTERVAL_MS, runCenterReplicaPull } from "../src/lib/shared-ledger-center-replica-pull.js";
import { CENTER_REPLICA_PULL_FIRST_DELAY_MS, openLedgerReadOnly, startCenterReplicaPull } from "../src/lib/shared-ledger-center-replica-pull-wiring.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { CENTER, fakeFeature, FEATURE_UUID, ledgerSnapshot, LOCAL_ID, node, replicaKit } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { await open?.close(); open = null; });
async function kit() { open = await replicaKit(); return open; }

const OTHER_HOME = "11111111-2222-4333-8444-555555555555", NOT_PLANNED = "44444444-2222-4333-8444-555555555555";
const replicaEvents = (k: Kit) => (k.f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE actor = ? AND target = ? AND kind = 'feature'")
  .get(REPLICA_ACTOR, LOCAL_ID) as { n: number }).n;
const n7Features = (k: Kit) => (k.f.db.prepare("SELECT COUNT(*) AS n FROM features WHERE id LIKE 'n7-%'").get() as { n: number }).n;
const stateRaw = (k: Kit) => { const p = join(k.dir, "shared-center-replicas.json"); return existsSync(p) ? readFileSync(p, "utf8") : null; };

function pull(k: Kit, mode: RecoveryMode, extra: Partial<Parameters<typeof runCenterReplicaPull>[0]> = {}) {
  const lines: string[] = [], asked: [string, RecoveryKey][] = [];
  const policy = (project: string, key: RecoveryKey) => { asked.push([project, key]); return { mode }; };
  const run = () => runCenterReplicaPull({ db: () => k.f.db, readDb: () => openLedgerReadOnly(k.f.db.filename), policy, log: (l) => lines.push(l), stateDir: k.dir, ...extra });
  return { lines, asked, run };
}

/** Same as shared-center-replica.test.ts claimAndBind: committed claim → card → local dag-bind. */
async function claimAndBind(k: Kit, key: string, taskId: string, globs: string[]) {
  const op = `bind-${key}`;
  await putCenterClaim({ op, body: { featureId: FEATURE_UUID, nodeKey: key, sourceTaskId: taskId }, digest: v2ObjectDigest(op),
    localFeatureId: LOCAL_ID, key, taskId, state: "pending" }, k.dir);
  await setCenterClaimState(op, "committed", k.dir);
  createTask(k.f.db, { actor: k.f.actor }, { project: k.f.project, id: taskId, title: `卡 ${key}`, kind: "code",
    extra: { sharedFeatureId: LOCAL_ID, fileGlobs: globs } });
  expect(await k.f.ledger(["dag-bind", LOCAL_ID, key, taskId, "--rev", String(getFeature(k.f.db, LOCAL_ID)!.rev)])).toMatchObject({ ok: true });
}

test("recovery key centerReplicaPull is registered exactly once", () => {
  expect(RECOVERY_KEYS.filter((k) => k === "centerReplicaPull")).toHaveLength(1);
});

test("AC1 on: a published home planning feature missing locally lands in one round, same id as the CLI, one replica event", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const p = pull(k, "on");
  const rounds = await p.run();
  expect(p.asked).toEqual([[k.f.project, "centerReplicaPull"]]);
  expect(rounds).toMatchObject([{ project: k.f.project, mode: "on", features: [{ centerFeatureId: FEATURE_UUID, result: "created", localFeatureId: LOCAL_ID, version: 2 }] }]);
  expect(getFeature(k.f.db, LOCAL_ID)).toMatchObject({ project: k.f.project, currentVersion: 2 });
  expect(replicaEvents(k)).toBe(1);
  // The CLI afterwards sees the same replica, unchanged.
  expect(await k.sync()).toMatchObject({ features: [{ centerFeatureId: FEATURE_UUID, result: "unchanged", localFeatureId: LOCAL_ID }] });
  expect((await p.run())[0]!.features).toMatchObject([{ result: "unchanged" }]);
  expect(replicaEvents(k)).toBe(1);
});

test("AC2 on: a published revise (version +1) replays in one round; the bound node stays bound", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const p = pull(k, "on");
  await p.run();
  await claimAndBind(k, "alpha", "n7x-alpha", ["src/n7x/alpha.ts"]);
  k.center.publish(fakeFeature({ version: 3, rev: 7, bindings: [{ nodeKey: "alpha", taskId: "center-task-1" }],
    nodes: [node("alpha"), node("beta", { deps: ["alpha"] }), node("gamma", { deps: ["beta"] })] }), "revise");
  expect((await p.run())[0]!.features).toMatchObject([{ centerFeatureId: FEATURE_UUID, result: "replayed", version: 3 }]);
  expect(getFeature(k.f.db, LOCAL_ID)!.currentVersion).toBe(3);
  expect(effectiveNodes(k.f.db, getDagVersion(k.f.db, LOCAL_ID, 3)!).map((n) => [n.key, n.taskId]))
    .toEqual([["alpha", "n7x-alpha"], ["beta", null], ["gamma", null]]);
  expect(readCenterReplicas().replicas[FEATURE_UUID]).toMatchObject({ version: 3, rev: 7 });
});

test("AC3 observe: one 'would create' line, no file or ledger write; the same feature + version is not logged again", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const before = ledgerSnapshot(k.f.db), raw = stateRaw(k);
  const p = pull(k, "observe", { seen: new Set() });
  expect((await p.run())[0]).toMatchObject({ mode: "observe", features: [{ result: "created", localFeatureId: LOCAL_ID, version: 2 }] });
  expect(p.lines).toHaveLength(1);
  expect(p.lines[0]).toContain("本会新建");
  expect(p.lines[0]).toContain(FEATURE_UUID);
  await p.run();
  expect(p.lines).toHaveLength(1);
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
  expect(stateRaw(k)).toBe(raw);
  expect(getFeature(k.f.db, LOCAL_ID)).toBeNull();
  // A new center version is a new line ("would update" once the replica exists).
  await syncCenterReplicas(k.f.db, { localProject: k.f.project });
  k.center.publish(fakeFeature({ version: 3, rev: 6 }), "none");
  await p.run();
  expect(p.lines).toHaveLength(2);
  expect(p.lines[1]).toContain("本会更新");
  expect(getFeature(k.f.db, LOCAL_ID)!.currentVersion).toBe(2);
});

test("AC3 off: syncCenterReplicas is never called (no center request, no write)", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const before = ledgerSnapshot(k.f.db), raw = stateRaw(k);
  const p = pull(k, "off");
  expect(await p.run()).toEqual([{ project: k.f.project, mode: "off", features: [] }]);
  expect(k.center.requests).toEqual([]);
  expect(ledgerSnapshot(k.f.db)).toEqual(before);
  expect(stateRaw(k)).toBe(raw);
  expect(p.lines).toEqual([]);
});

test("AC4 other home / not planning / first detail read failing: the reason stays in the replica state and status shows it", async () => {
  const k = await kit();
  k.center.publish(fakeFeature({ id: OTHER_HOME, homeInstanceId: "home-b" }));
  k.center.publish(fakeFeature({ id: NOT_PLANNED, title: "非规划", authorityMode: "source" }));
  k.center.publish(fakeFeature());
  k.center.features.delete(FEATURE_UUID); // listed as published, detail answers 403 → first read fails, no prior replica
  const p = pull(k, "on");
  expect((await p.run())[0]!.features).toEqual([
    { centerFeatureId: OTHER_HOME, result: "skipped", reason: REPLICA_REASONS.notHome },
    { centerFeatureId: NOT_PLANNED, result: "skipped", reason: REPLICA_REASONS.notPlanned },
    { centerFeatureId: FEATURE_UUID, result: "failed", reason: REPLICA_REASONS.credentialRejected },
  ]);
  const skipped = readCenterReplicas().skipped!;
  expect(skipped[OTHER_HOME]).toMatchObject({ lastSkip: REPLICA_REASONS.notHome, lastError: null });
  expect(skipped[NOT_PLANNED]).toMatchObject({ lastSkip: REPLICA_REASONS.notPlanned, lastError: null });
  expect(skipped[FEATURE_UUID]).toMatchObject({ lastSkip: null, lastError: REPLICA_REASONS.credentialRejected });
  const status = await k.status() as { skipped: { centerFeatureId: string; lastSkip: string | null; lastError: string | null; at: string }[] };
  expect(status.skipped.map((s) => [s.centerFeatureId, s.lastSkip, s.lastError])).toEqual([
    [OTHER_HOME, REPLICA_REASONS.notHome, null], [NOT_PLANNED, REPLICA_REASONS.notPlanned, null], [FEATURE_UUID, null, REPLICA_REASONS.credentialRejected]]);
  expect(typeof status.skipped[0]!.at).toBe("string");
  // An unchanged reason keeps its first time; once the feature lands its skip entry goes away.
  k.center.publish(fakeFeature(), "none");
  expect((await p.run())[0]!.features.find((f) => f.centerFeatureId === FEATURE_UUID)).toMatchObject({ result: "created" });
  expect(readCenterReplicas().skipped![FEATURE_UUID]).toBeUndefined();
  expect(readCenterReplicas().skipped![OTHER_HOME]!.at).toBe(skipped[OTHER_HOME]!.at);
});

test("AC4 a project mismatch is a skip with its own reason; an older state file without `skipped` still reads", async () => {
  const k = await kit();
  await updateCenterReplicas(k.dir, (s) => { delete s.skipped; });
  expect(readCenterReplicas().skipped).toBeUndefined();
  expect(await k.status()).toMatchObject({ ok: true, skipped: [] });
  k.center.publish(fakeFeature());
  const real = k.center.features.get(FEATURE_UUID)!;
  const fetchOtherProject = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await fetch(input, init);
    if (!/\/features\/[^/]+$/.test(new URL(String(input instanceof Request ? input.url : input)).pathname)) return res;
    const body = await res.json() as { feature: { projectId: string } };
    body.feature.projectId = "another-project";
    return Response.json(body);
  }) as typeof fetch;
  expect(real.id).toBe(FEATURE_UUID);
  expect((await pull(k, "on", { fetch: fetchOtherProject }).run())[0]!.features)
    .toEqual([{ centerFeatureId: FEATURE_UUID, result: "skipped", reason: REPLICA_REASONS.otherProject }]);
  expect(readCenterReplicas().skipped![FEATURE_UUID]).toMatchObject({ lastSkip: REPLICA_REASONS.otherProject });
});

/** Holds every feature-detail response until `open()`; counts how many arrived. */
function gate() {
  let release!: () => void, arrived!: () => void;
  const opened = new Promise<void>((r) => { release = r; }), reached = new Promise<void>((r) => { arrived = r; });
  const f = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await fetch(input, init);
    if (!/\/features\/[^/]+$/.test(new URL(String(input instanceof Request ? input.url : input)).pathname)) return res;
    const body = await res.text();
    arrived();
    await opened;
    return new Response(body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetch: f, open: release, reached };
}

test("AC5 CLI sync running: the pull round skips (busy), only the CLI writes, one feature", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const g = gate();
  const cli = syncCenterReplicas(k.f.db, { localProject: k.f.project, fetch: g.fetch });
  await g.reached;
  const rounds = await pull(k, "on").run();
  expect(rounds).toMatchObject([{ mode: "on", busy: true, features: [] }]);
  g.open();
  expect((await cli).features).toMatchObject([{ result: "created" }]);
  expect(n7Features(k)).toBe(1);
  expect(replicaEvents(k)).toBe(1);
});

test("AC5 pull running: the CLI goes on under the per-id lock; one side creates, the other reads it (unchanged), no duplicate", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const g = gate();
  const round = pull(k, "on", { fetch: g.fetch }).run();
  await g.reached;
  const cli = syncCenterReplicas(k.f.db, { localProject: k.f.project });
  await Bun.sleep(300);
  g.open();
  const results = [...(await round)[0]!.features, ...(await cli).features].map((f) => f.result).sort();
  expect(results).toEqual(["created", "unchanged"]);
  expect(n7Features(k)).toBe(1);
  expect(replicaEvents(k)).toBe(1);
});

test("a failed round logs one line with the error name / fixed reason and the next round retries", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  k.center.state.mode = "unauthorized";
  const p = pull(k, "on");
  expect((await p.run())[0]).toMatchObject({ error: REPLICA_REASONS.credentialRejected, features: [] });
  expect(p.lines).toEqual([`[center-replica-pull] ${k.f.project} 本轮失败: ${REPLICA_REASONS.credentialRejected}`]);
  const throwing = pull(k, "on", { db: () => { throw new TypeError("boom 内部细节"); } });
  expect((await throwing.run())[0]).toMatchObject({ error: "TypeError" });
  expect(throwing.lines).toEqual([`[center-replica-pull] ${k.f.project} 本轮失败: TypeError`]);
  k.center.state.mode = "ok";
  expect((await p.run())[0]!.features).toMatchObject([{ result: "created" }]);
});

/** Injected timers: records what was armed, fires nothing on its own. */
function fakeTimers() {
  const armed: { kind: "timeout" | "interval"; ms: number; fn: () => void; unref: boolean }[] = [];
  const arm = (kind: "timeout" | "interval") => (fn: () => void, ms: number) => {
    const t = { kind, ms, fn, unref: false };
    armed.push(t);
    return { unref: () => { t.unref = true; } };
  };
  return { armed, timers: { setTimeout: arm("timeout"), setInterval: arm("interval") } };
}

test("wiring: first round ~1 minute after start, then every 5 minutes, timers unref'd; mode read per round", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const t = fakeTimers(), lines: string[] = [];
  let mode: RecoveryMode = "off", dbOpened = 0;
  startCenterReplicaPull({ db: () => (dbOpened++, k.f.db), readDb: () => (dbOpened++, openLedgerReadOnly(k.f.db.filename)),
    policy: () => ({ mode }), log: (l) => lines.push(l), stateDir: k.dir }, t.timers);
  expect(t.armed.map(({ kind, ms, unref }) => [kind, ms, unref])).toEqual([["timeout", CENTER_REPLICA_PULL_FIRST_DELAY_MS, true]]);
  expect(CENTER_REPLICA_PULL_FIRST_DELAY_MS).toBe(60_000);
  expect(k.center.requests).toEqual([]);
  t.armed[0]!.fn(); // first round, off: no center request, no ledger connection
  await Bun.sleep(50);
  expect(t.armed.slice(1).map(({ kind, ms, unref }) => [kind, ms, unref])).toEqual([["interval", CENTER_REPLICA_PULL_INTERVAL_MS, true]]);
  expect(CENTER_REPLICA_PULL_INTERVAL_MS).toBe(300_000);
  expect([k.center.requests, dbOpened, n7Features(k)]).toEqual([[], 0, 0]);
  mode = "on"; // switched without restarting: the next tick syncs
  t.armed[1]!.fn();
  for (let i = 0; i < 100 && n7Features(k) === 0; i++) await Bun.sleep(20);
  expect(n7Features(k)).toBe(1);
  expect(dbOpened).toBeGreaterThan(0);
});

test("wiring: a tick while the last round still runs is skipped; a throwing round logs its error name and never escapes", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const g = gate(), t = fakeTimers(), lines: string[] = [];
  let policyCalls = 0;
  const { tick } = startCenterReplicaPull({ db: () => k.f.db, readDb: () => openLedgerReadOnly(k.f.db.filename), policy: () => (policyCalls++, { mode: "on" }), log: (l) => lines.push(l),
    stateDir: k.dir, fetch: g.fetch }, t.timers);
  const first = tick();
  await g.reached;
  await tick(); // overlapping: returns at once, no second round
  expect(policyCalls).toBe(1);
  g.open();
  await first;
  expect(n7Features(k)).toBe(1);
  const bad = startCenterReplicaPull({ db: () => k.f.db, readDb: () => openLedgerReadOnly(k.f.db.filename), policy: () => ({ mode: "on" }), log: (l) => lines.push(l), stateDir: k.dir,
    get seen(): Set<string> { throw new RangeError("内部细节"); } }, fakeTimers().timers);
  await bad.tick();
  expect(lines).toEqual(["[center-replica-pull] 本轮失败: RangeError"]);
});

/** Every file under the state dir with its bytes (lock files, ledger, replica state). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    out[p] = readFileSync(p).toString("base64");
  }
  return out;
}

test("AC3 observe (review r1): no lock file appears even mid-round; the ledger is opened read only and never created", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  const before = tree(k.dir);
  const seen: { during?: Record<string, string> } = {};
  const spy = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await fetch(input, init);
    if (/\/features\/[^/]+$/.test(new URL(String(input instanceof Request ? input.url : input)).pathname)) seen.during = tree(k.dir);
    return res;
  }) as typeof fetch;
  expect((await pull(k, "observe", { fetch: spy }).run())[0]!.features).toMatchObject([{ result: "created" }]);
  expect(seen.during).toEqual(before);
  expect(tree(k.dir)).toEqual(before);
  // Observe against a ledger that does not exist: the round fails with one line, nothing is created.
  const missing = join(k.dir, "no-such-ledger.sqlite");
  const p = pull(k, "observe", { readDb: () => openLedgerReadOnly(missing) });
  expect((await p.run())[0]).toMatchObject({ mode: "observe", error: "Error", features: [] });
  expect(p.lines).toEqual([`[center-replica-pull] ${k.f.project} 本轮失败: Error`]);
  expect(existsSync(missing)).toBe(false);
});

test("AC3 observe (review r1): the prediction matches a real sync — id taken → refused, rev-only change → unchanged", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  // The local id is held by another planning mode: observe and the real sync both refuse it.
  await writeSharedLedgerMode(LOCAL_ID, { authorityMode: "planning", sharedPlanning: true,
    centerPlanned: { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId, centerFeatureId: "other-center-feature" } }, k.dir, k.f.db.filename);
  const p = pull(k, "observe");
  expect((await p.run())[0]!.features).toEqual([{ centerFeatureId: FEATURE_UUID, result: "refused", reason: REPLICA_REASONS.idTaken }]);
  expect(p.lines).toEqual([`[center-replica-pull] observe ${k.f.project}: 本会拒收 ${FEATURE_UUID}（${REPLICA_REASONS.idTaken}）`]);
  expect((await k.sync())).toMatchObject({ features: [{ result: "refused", reason: REPLICA_REASONS.idTaken }] });
  await writeSharedLedgerMode(LOCAL_ID, { authorityMode: "source", sharedPlanning: false }, k.dir, k.f.db.filename);
  await updateCenterReplicas(k.dir, (s) => { s.refused = {}; });
  // Synced at v2; the center bumps only rev 5 → 6: observe says unchanged (no line), the real sync agrees.
  expect((await k.sync())).toMatchObject({ features: [{ result: "created", version: 2 }] });
  k.center.publish(fakeFeature({ rev: 6 }), "none");
  const q = pull(k, "observe");
  expect((await q.run())[0]!.features).toMatchObject([{ result: "unchanged", version: 2 }]);
  expect(q.lines).toEqual([]);
  expect((await k.sync())).toMatchObject({ features: [{ result: "unchanged", version: 2 }] });
});

test("review r1: a failing detail read logs one round error line (observe and on); a throwing policy logs and counts as off", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  k.center.features.delete(FEATURE_UUID); // listed, detail answers 403
  for (const mode of ["observe", "on"] as const) {
    const p = pull(k, mode);
    expect((await p.run())[0]).toMatchObject({ mode, error: REPLICA_REASONS.credentialRejected, features: [{ result: "failed" }] });
    expect(p.lines).toEqual([`[center-replica-pull] ${k.f.project} 本轮失败: ${REPLICA_REASONS.credentialRejected}`]);
  }
  const requests = k.center.requests.length, lines: string[] = [];
  const rounds = await runCenterReplicaPull({ db: () => k.f.db, readDb: () => openLedgerReadOnly(k.f.db.filename), stateDir: k.dir,
    policy: () => { throw new SyntaxError("内部细节"); }, log: (l) => lines.push(l) });
  expect(rounds).toEqual([{ project: k.f.project, mode: "off", features: [] }]);
  expect(lines).toEqual([`[center-replica-pull] ${k.f.project} 读档位失败: SyntaxError，本轮按 off 处理`]);
  expect(k.center.requests.length).toBe(requests);
});
