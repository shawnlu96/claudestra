/** S2F6 acceptance line 1 through the production offer (lendCentralPoolPort.offer: autoSnapshot family, write materials, the peer
 * gate render) on a synthetic file ledger and the S2C fake center: a spec with a full commit SHA writes no local event, a central
 * write order holds the write lease a later fix order needs, and a replay after the base moved binds the center's order id only to
 * the material it was created from. */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { sweepLend } from "../src/lib/ledger-lend.js";
import { checkView } from "../src/lib/ledger-lend-central-checks.js";
import { writeLendCentralOrder } from "../src/lib/ledger-lend-central-home.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { configureLendCentralPool, lendCentralPoolPort } from "../src/lib/ledger-lend-central-pool.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { drivePool } from "../src/lib/scheduler-pool-tick.js";
import { configureSchedulerV2Pass } from "../src/lib/scheduler-v2-pass.js";
import { V2ContractError, type V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { createStage2Transport, type Stage2Connection } from "../src/lib/shared-ledger-v2-transport.js";
import type { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { ACTORS, EXEC_TASK, featureRows, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const P = "p", T = "T1", PEER = "mate", FP = "abcd-ef01-2345-6789", REPO = "o/r", BRANCH = "lend/T1-abcd";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REMOTE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: REPO };
const BORROW: BorrowEntry[] = [{ peer: PEER, projects: [P], roles: ["review", "write"], maxOpen: 3 }];
const pair = generateKeyPairSync("ed25519");
const KEY = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const dirs: string[] = [], dbs: string[] = [];
afterEach(() => {
  configureLendCentralPool(null); configureSchedulerV2Pass(null);
  for (const path of dbs.splice(0)) closeLedger(path);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `center`: the center task row patched (a first write: stage build, no head yet); `borrow`: this home's borrow list now. */
function world(o: { center?: Record<string, unknown>; borrow?: BorrowEntry[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s2f6-prod-")); dirs.push(dir);
  const path = join(dir, "ledger.sqlite"); dbs.push(path);
  const db: Database = openLedger(path);
  let now = 1000;
  const at = (actor: string) => ({ actor, now: now += 10 });
  createTask(db, at("owner"), { project: P, id: T, title: T, kind: "code", agent: "agent-one", extra: { sharedFeatureId: "feature-exec", fileGlobs: ["src/lib/x.ts"] } });
  setWorkflow(db, at("owner"), { taskId: T, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  const spec = join(dir, "T1.md");
  writeFileSync(spec, `规格：只改 src/lib/x.ts，起点是提交 ${SHA}\n验收：单测全绿`);
  db.run("UPDATE tasks SET spec = ?, stage = 'build' WHERE id = ?", [spec, T]);
  // The card's author session, bound before its write goes to the pool (its create intent is not part of this world).
  db.run("PRAGMA foreign_keys = OFF");
  db.run(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, 'author', 'agent-one', 'sess-author', 'claude', 'acp', 'active', 'bind-author', 1000, 1000)`, [T]);
  db.run("PRAGMA foreign_keys = ON");
  recordHello(db, PEER, null, { v: 1, proto: 2, boot: "boot", seq: 1, slots: { codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } }, paused: null,
    grant: { until: Date.now() + 3_600_000, roles: ["review", "write"], repos: [REPO], ordersPerDay: 50, ordersLeftToday: 50 } }, Date.now());
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { "feature-exec": { authorityMode: "execution", sharedPlanning: true,
    centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: "feature-exec", epoch: 1 } } } }));
  configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
  const k = kit(), center = k.center, rows = featureRows("feature-exec", T, "execution");
  center.seed({ tasks: [{ ...rows.task, ...o.center }], workflows: [rows.workflow] });
  expect(k.post(ACTORS.owner, k.command("lease.acquire", { ...EXEC_TASK, taskId: T, homeInstanceId: "local" })).status).toBe(200);
  const conn = (actor: V2Actor): Stage2Connection => ({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team",
    personId: actor.personId, instanceId: actor.instanceId, bearer: "s2f6-bearer-secret-0123456789" }, key: KEY, projectId: "project",
    fetch: center.fetch(() => actor) as NonNullable<Stage2Connection["fetch"]> });
  const stage2 = createStage2Transport(conn(ACTORS.owner));
  const task = { ...rows.task, ...o.center } as typeof rows.task & { spec: Record<string, unknown> };
  const view = { tasks: [{ ...task, spec: { ...task.spec, artifactId: "artifact" } }], workflows: [rows.workflow] };
  // `net.down`: a lend.create fails before it reaches the center (unavailable); receipt lookups still answer.
  const net = { down: false }, borrowNow = { list: o.borrow ?? BORROW };
  const lend: typeof stage2.lend = (read) => {
    const t = stage2.lend(read);
    return { receipt: (id) => t.receipt(id), view: (id) => t.view(id),
      command: async (c) => { if (net.down) throw new V2ContractError("unavailable"); return t.command(c); } };
  };
  const wiring = { dir, transportFor: () => ({ lend }), mode: () => "on", observe: () => {}, scope: () => ({ ...V2_FIXTURE_SCOPE }),
    featureOfTask: () => ({ localFeatureId: "feature-exec", projectId: "project", centerFeatureId: "feature-exec", epoch: 1 }),
    cachedView: () => view } as unknown as Stage2Wiring;
  const remote: { main: RemoteHead } = { main: { ok: true, head: "b".repeat(40) } };
  const port = lendCentralPoolPort({ wiring, db: () => db, fence: () => V2_FIXTURE_FENCE, instanceId: () => "local",
    peer: async (name) => name === PEER ? { instanceId: "peer-b", fp: FP } : null, remoteHead: async () => remote.main, borrow: async () => borrowNow.list });
  configureLendCentralPool(port);
  const calls: string[][] = [];
  // The pending pool intent as the auto tick planned it (no local worker, this home's borrow at planning time).
  const intent = (): SchedulerIntent => {
    const plan = planScheduler(autoSnapshot(db, getTask(db, T)!, { registry: [], maxWorkers: 2, now: Date.now(), pool: { remote: REMOTE, borrow: BORROW } }));
    expect(plan).toMatchObject({ kind: "intent", recipient: `peer:${PEER}` });
    return { id: plan.kind === "intent" ? plan.id : "", taskId: T, recipient: `peer:${PEER}`, action: plan.kind === "intent" ? plan.action : "" } as SchedulerIntent;
  };
  const drive = () => drivePool({ manager: async (...args: string[]) => { calls.push(args); return { ok: true, outcome: "pooled" }; },
    notifyPm: async () => {}, lost: () => (e) => { throw e; }, db: null }, getTask(db, T)!, intent(), 2, REMOTE);
  const homeRow = () => db.query("SELECT orderId, head, branch, base, text FROM lend_orders WHERE taskId = ?").get(T) as
    { orderId: string; head: string; branch: string; base: string; text: string } | null;
  return { db, k, center, port, drive, calls, remote, homeRow, intent, net, borrowNow };
}

test("[验收线 1] the production offer: a spec with a full commit SHA goes out shortened, no local event, the write lease held", async () => {
  const w = world();
  const events = listEvents(w.db, { project: P, target: T }).length;
  expect(await w.drive()).toMatchObject({ step: "pool_pooled" });
  const home = w.homeRow()!;
  expect(w.center.rows().orders.get(home.orderId)).toMatchObject({ status: "pooled", taskId: T, step: "write", branch: BRANCH, base: "main" });
  expect(home).toMatchObject({ branch: BRANCH, base: "main", head: "b".repeat(40) });
  expect(home.text).toContain(SHA.slice(0, 12));
  expect(home.text).not.toContain(SHA);
  // forPeer's sha_cut note is not written: the S2G gate refuses an execution card's events.
  expect(listEvents(w.db, { project: P, target: T }).length).toBe(events);
  expect(w.calls).toEqual([]);
  // The write lease a later fix order is checked against, as the legacy offer holds it.
  expect(getWriteLease(w.db, T)).toMatchObject({ peer: PEER, fp: FP, branch: BRANCH, repo: REPO, state: "held" });
});

test("[验收线 1] write then fix: the fix order of a central write renders through the held write lease", async () => {
  const w = world();
  expect(await w.drive()).toMatchObject({ step: "pool_pooled" });
  // The write delivered on the lend branch and a P1 review: the card in fix, the report on disk.
  const report = join(w.db.filename, "..", "report.md");
  writeFileSync(report, "# 审查\n\nP1：竞态");
  w.db.run("UPDATE lend_orders SET status = 'done' WHERE taskId = ?", [T]);
  w.db.run("UPDATE tasks SET stage = 'fix', round = 1, branch = ?, headSHA = ? WHERE id = ?", [BRANCH, "c".repeat(40), T]);
  w.db.run(`INSERT INTO events (project, target, kind, actor, ts, text, data) VALUES (?, ?, 'deliver', 'mate', 1990, 'delivered', ?)`,
    [P, T, JSON.stringify({ headSHA: "c".repeat(40) })]);
  w.db.run(`INSERT INTO events (project, target, kind, actor, ts, text, data) VALUES (?, ?, 'review', 'rv', 2000, 'changes', ?)`,
    [P, T, JSON.stringify({ round: 1, head: "c".repeat(40), verdict: "changes", reviewer: "rv", reviewerSessionId: "s-rv", reviewerFamily: "codex",
      p0: 0, p1: 1, p2: 0, path: report, findings: [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "[验收线 1] race" }] })]);
  const offer = await w.port.offer(getTask(w.db, T)!, w.intent(), "lend:T1:s1:r1:a0", { maxWorkers: 2, remote: REMOTE }, null);
  expect(offer?.fields).toMatchObject({ step: "fix", branch: BRANCH, head: "c".repeat(40) });
});

test("[验收线 1] a replay after the base moved: the home row is rendered from the journaled material, as the center holds it", async () => {
  const w = world();
  expect(await w.drive()).toMatchObject({ step: "pool_pooled" });
  const first = w.homeRow()!;
  // The center confirmed, the home row never landed; main moved before the next pass.
  w.db.run("DELETE FROM lend_orders WHERE orderId = ?", [first.orderId]);
  w.remote.main = { ok: true, head: "c".repeat(40) };
  expect(await w.drive()).toMatchObject({ step: "pool_pooled" });
  const again = w.homeRow()!;
  expect(w.center.rows().orders.size).toBe(1);
  expect([again.orderId, again.head, w.center.rows().orders.get(again.orderId)!.head]).toEqual([first.orderId, "b".repeat(40), "b".repeat(40)]);
  expect(again.text).toBe(first.text);
});

test("[验收线 3] a first write (center task in build, no head yet): the claimed order passes the delivery view check", async () => {
  const w = world({ center: { stage: "build", head: null } });
  expect(await w.drive()).toMatchObject({ step: "pool_pooled" });
  const orderId = w.homeRow()!.orderId, o = w.center.rows().orders.get(orderId)!;
  const worker = { kind: "peer_agent" as const, instanceId: "peer-b", agentId: "agent-lend-1" };
  expect(w.k.post(ACTORS.executor, w.k.command("lend.claim", { claim: { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, orderId, taskId: o.taskId,
    specRev: o.specRev, round: o.round, head: o.head, leaseGen: o.leaseGen + 1, executorInstanceId: "peer-b", worker, grantId: o.grantId,
    grantDigest: o.grantDigest, claimedAt: 10_000 } })).status).toBe(200);
  const view = await w.port.transport(P)!.view(orderId);
  const binding = await w.port.binding!(orderId, view);
  // What preflight checks before the publish: the order's head is the write's base, the task has none until its first delivery.
  expect(checkView(binding!, view, true).order.head).toBe("b".repeat(40));
  // A center task that already has another head: no order is cut that preflight would refuse.
  const moved = world({ center: { stage: "build", head: "d".repeat(40) } });
  expect(await moved.drive()).toMatchObject({ step: "held" });
  expect(moved.center.rows().orders.size).toBe(0);
});

test("[验收线 1] the home's borrow revoked after planning: the pending pool intent creates no central order", async () => {
  for (const borrow of [BORROW, []]) {
    const w = world({ borrow });
    // A review round (head and PR on the card): its family comes straight from the peer's slots, whatever this home's borrow says.
    w.db.run("UPDATE tasks SET stage = 'review', headSHA = ?, pr = ? WHERE id = ?", ["c".repeat(40), `https://github.com/${REPO}/pull/7`, T]);
    const out = await w.drive();
    expect([out.step, w.center.rows().orders.size], out.detail).toEqual(borrow.length ? ["pool_pooled", 1] : ["held", 0]);
  }
});

test("[验收线 1] a create that never reached the center is rechecked: the home's borrow revoked meanwhile creates no central order", async () => {
  for (const revoke of [false, true]) {
    const w = world();
    w.db.run("UPDATE tasks SET stage = 'review', headSHA = ?, pr = ? WHERE id = ?", ["c".repeat(40), `https://github.com/${REPO}/pull/7`, T]);
    w.net.down = true;
    expect(await w.drive()).toMatchObject({ step: "held" });
    expect(w.center.rows().orders.size).toBe(0);
    w.net.down = false;
    if (revoke) w.borrowNow.list = [];
    const out = await w.drive();
    expect([out.step, w.center.rows().orders.size], out.detail).toEqual(revoke ? ["held", 0] : ["pool_pooled", 1]);
  }
});

test("[验收线 4] the legacy sweep leaves a central order alone; a local order past its TTL is still sent back", async () => {
  const w = world();
  expect(await w.drive()).toMatchObject({ step: "pool_pooled" });
  const central = w.homeRow()!.orderId, old = Date.now() - 31 * 60_000;
  createTask(w.db, { actor: "owner", now: 5000 }, { project: P, id: "L1", title: "L1", kind: "code" });
  writeLendCentralOrder(w.db, "order-local", { taskId: "L1", project: P, peer: PEER, family: "codex", step: "write", specRev: 1, round: 0,
    head: "b".repeat(40), repo: REPO, pr: null, wire: { orderId: "order-local" }, text: "t", sha256: "a".repeat(64), leaseMs: 60_000,
    createdBy: "scheduler", branch: "lend/L1-abcd", base: "main" });
  w.db.run("UPDATE lend_orders SET createdAt = ?, updatedAt = ?", [old, old]);
  const notices = sweepLend(w.db, { actor: "lend-sweeper", now: Date.now() });
  expect(notices.map((n) => n.taskId)).toEqual(["L1"]);
  const status = (id: string) => (w.db.query("SELECT status FROM lend_orders WHERE orderId = ?").get(id) as { status: string }).status;
  expect([status(central), status("order-local")]).toEqual(["pooled", "cancelled"]);
});
