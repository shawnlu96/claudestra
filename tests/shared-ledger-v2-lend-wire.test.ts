/** S2F6 acceptance lines 1, 2 and 4: a central card's pool step through drivePool (scheduler-pool-tick.ts) over a synthetic
 * file ledger, S2D's real route (modes file + switch port), the S2C fake center behind the real S2T transport, and the
 * production pool port (lendCentralPoolPort: transport / outbox / binding / observe) with the offer's trusted fields injected. */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendBindings } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import { getLendOrder, pollLend } from "../src/lib/ledger-lend.js";
import { lendCreateRequestId, type LendCentralCreateFields } from "../src/lib/ledger-lend-central-create.js";
import { writeLendCentralOrder, type LendCentralHomeOrder } from "../src/lib/ledger-lend-central-home.js";
import { centralPoolStep, configureLendCentralPool, lendCentralPoolPort } from "../src/lib/ledger-lend-central-pool.js";
import { LendCentralOutbox } from "../src/lib/ledger-lend-central-state.js";
import { pushCandidates } from "../src/lib/ledger-lend-peers.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { drivePool } from "../src/lib/scheduler-pool-tick.js";
import { configureSchedulerV2Pass, type SchedulerV2Switch } from "../src/lib/scheduler-v2-pass.js";
import { parseCommand, type V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { createStage2Transport, type Stage2Connection } from "../src/lib/shared-ledger-v2-transport.js";
import type { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { ACTORS, EXEC_TASK, featureRows, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const P = "p", H = "b".repeat(40), D = "a".repeat(64), PEER = "peerB", FP = "abcd-ef01-2345-6789";
const REMOTE = { mode: "balance" as const, roles: ["review" as const, "write" as const], poolTimeoutMin: 15 };
const pair = generateKeyPairSync("ed25519");
const KEY = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const dirs: string[] = [], dbs: string[] = [];
afterEach(() => {
  configureLendCentralPool(null); configureSchedulerV2Pass(null);
  for (const path of dbs.splice(0)) closeLedger(path);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** task-exec (write) and task-exec-2 (review) on execution feature-exec; task-local on no feature (the local route). */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "s2f6-")); dirs.push(dir);
  const path = join(dir, "ledger.sqlite"); dbs.push(path);
  const db: Database = openLedger(path);
  let now = 1000;
  for (const [id, feature] of [["task-exec", "feature-exec"], ["task-exec-2", "feature-exec"], ["task-local", null]] as const) {
    createTask(db, { actor: "owner", now: now += 10 }, { project: P, id, title: id, kind: "code", ...(feature ? { extra: { sharedFeatureId: feature } } : {}) });
  }
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { "feature-exec": { authorityMode: "execution", sharedPlanning: true,
    centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: "feature-exec", epoch: 1 } } } }));
  let sw: SchedulerV2Switch = "on";
  configureSchedulerV2Pass({ mode: () => sw, wrapManager: (m) => m });
  const k = kit(), center = k.center, second = featureRows("feature-exec", "task-exec-2", "execution");
  center.seed({ tasks: [second.task], workflows: [second.workflow] });
  for (const taskId of ["task-exec", "task-exec-2"]) {
    expect(k.post(ACTORS.owner, k.command("lease.acquire", { ...EXEC_TASK, taskId, homeInstanceId: "local" })).status).toBe(200);
  }
  const conn = (actor: V2Actor): Stage2Connection => ({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team",
    personId: actor.personId, instanceId: actor.instanceId, bearer: "s2f6-bearer-secret-0123456789" }, key: KEY, projectId: "project",
    fetch: center.fetch(() => actor) as NonNullable<Stage2Connection["fetch"]> });
  const stage2 = createStage2Transport(conn(ACTORS.owner)), observed: Record<string, unknown>[] = [];
  const wiring = { dir, transportFor: () => stage2, mode: () => sw, observe: (e: Record<string, unknown>) => { observed.push(e); },
    scope: () => ({ ...V2_FIXTURE_SCOPE }), open: () => ({ signer: { personId: "person", instanceId: "local" } }) } as unknown as Stage2Wiring;
  const peer = async (name: string) => name === PEER ? { instanceId: "peer-b", fp: FP } : null;
  const port = lendCentralPoolPort({ wiring, db: () => db, fence: () => V2_FIXTURE_FENCE, instanceId: () => "local", peer });
  const step = (taskId: string) => taskId === "task-exec" ? "write" as const : "review" as const;
  // The offer's trusted fields as the scheduler wiring would read them (center view revs, S2R fence, grant, peer registry).
  const fields = (taskId: string): LendCentralCreateFields => ({ ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, ...EXEC_TASK, taskId, featureId: "feature-exec",
    family: "codex", step: step(taskId), executorInstanceId: "peer-b", specArtifactId: "artifact", head: H, round: 0,
    branch: step(taskId) === "write" ? "lend/task-exec-abcd" : null, base: step(taskId) === "write" ? "main" : null, grantId: "grant", grantDigest: D });
  const home = (orderId: string, taskId: string): LendCentralHomeOrder => ({ taskId, project: P, peer: PEER, family: "codex", step: step(taskId),
    specRev: 1, round: 0, head: H, repo: "team/repository", pr: null, wire: { v: 1, orderId, taskId }, text: `order ${orderId}`, sha256: D,
    leaseMs: 60_000, createdBy: "scheduler", branch: step(taskId) === "write" ? "lend/task-exec-abcd" : null, base: step(taskId) === "write" ? "main" : null });
  const offers: string[] = [];
  const configure = () => configureLendCentralPool({ ...port,
    offer: async (task, _intent, attemptKey) => { offers.push(attemptKey); return { fields: fields(task.id), home: (id) => home(id, task.id) }; } });
  const calls: string[][] = [];
  const manager = async (...args: string[]) => { calls.push(args); return { ok: true, outcome: "pooled", text: "legacy" }; };
  const drive = (taskId: string) => drivePool({ manager, notifyPm: async () => {}, lost: () => (e) => { throw e; }, db: null }, getTask(db, taskId)!,
    { id: `pool-${taskId}`, taskId, recipient: `peer:${PEER}`, action: taskId === "task-exec" ? "dispatch" : "review" } as SchedulerIntent, 2, REMOTE);
  const sent = () => center.log.filter(e => e.command === "lend.create").length;
  const bindings = lendBindings({ wiring, db: () => db, outboxDir: join(dir, "shared-ledger-v2-lend"), peer });
  const bindingFor = async (orderId: string) => { bindings.bindingFor(orderId); await Bun.sleep(30); return bindings.bindingFor(orderId); };
  return { dir, db, k, center, configure, drive, calls, sent, observed, offers, bindingFor, setSwitch: (v: SchedulerV2Switch) => { sw = v; } };
}
const centralRow = (db: Database, taskId: string) =>
  db.query("SELECT orderId, status, step, branch, base FROM lend_orders WHERE taskId = ?").get(taskId) as
    { orderId: string; status: string; step: string; branch: string | null; base: string | null } | null;

test("[验收线 1] one pool pass of a central card (on): one lend.create each for write and review, the home row under the center id, no replay", async () => {
  const w = world();
  // Before S2F6 (no pool port): the legacy `ledger scheduler-pool` runs and the center gets no order at all.
  for (const id of ["task-exec", "task-exec-2"]) expect(await w.drive(id)).toMatchObject({ step: "pool_pooled" });
  expect([w.calls.length, w.sent(), w.center.rows().orders.size]).toEqual([2, 0, 0]);
  w.calls.length = 0;
  w.configure();
  for (const id of ["task-exec", "task-exec-2"]) {
    const out = await w.drive(id);
    expect(out.step).toBe("pool_pooled");
    const row = centralRow(w.db, id)!;
    // The attempt key is the one the legacy offer would use; the journaled body is the contract-parsed lend.create.
    const command = new LendCentralOutbox(join(w.dir, "shared-ledger-v2-lend")).read(lendCreateRequestId(`lend:${id}:s1:r0:a0`))!.command;
    expect(parseCommand(structuredClone(command))).toEqual(command);
    if (command.type !== "lend.create") throw new Error("not lend.create");
    if (id === "task-exec") expect([command.payload.branch, command.payload.base]).toEqual(["lend/task-exec-abcd", "main"]);
    else expect(command.payload.step).toBe("review");
    expect(w.center.rows().orders.get(row.orderId)).toMatchObject({ status: "pooled", taskId: id, step: command.payload.step });
    expect(getLendOrder(w.db, row.orderId)).toMatchObject({ orderId: row.orderId, status: "pooled", peer: PEER });
    expect(await w.bindingFor(row.orderId)).toMatchObject({ localTaskId: id, binding: { order: { orderId: row.orderId }, peer: PEER } });
  }
  expect(w.offers).toEqual(["lend:task-exec:s1:r0:a0", "lend:task-exec-2:s1:r0:a0"]);
  expect([w.sent(), w.center.rows().orders.size, w.calls.length]).toEqual([2, 2, 0]); // never `ledger scheduler-pool`
  // The same round replayed: the live home row is synced, the center is not asked to create again.
  for (const id of ["task-exec", "task-exec-2"]) expect(await w.drive(id)).toMatchObject({ step: "pool_pooled" });
  expect([w.sent(), w.center.rows().orders.size]).toEqual([2, 2]);
  // A crash after the center confirmed and before the home row landed: the same attempt key answers from the journal.
  const lost = centralRow(w.db, "task-exec")!.orderId;
  w.db.query("DELETE FROM lend_orders WHERE orderId = ?").run(lost);
  expect(await w.drive("task-exec")).toMatchObject({ step: "pool_pooled" });
  expect(centralRow(w.db, "task-exec")!.orderId).toBe(lost);
  expect([w.sent(), w.center.rows().orders.size]).toEqual([2, 2]);
});

test("[验收线 2] off / observe: zero center requests, observe logs once per attempt key; a non-central card is byte-identical in every mode", async () => {
  const w = world();
  const legacy: unknown[] = [];
  for (const mode of ["on", "observe", "off"] as const) { // baseline: no pool port
    w.setSwitch(mode); legacy.push(await w.drive("task-local"));
  }
  const legacyCalls = structuredClone(w.calls);
  w.calls.length = 0;
  w.configure();
  const requests = w.center.log.length;
  for (const mode of ["off", "observe"] as const) {
    w.setSwitch(mode);
    for (let i = 0; i < 2; i++) for (const id of ["task-exec", "task-exec-2"]) await w.drive(id);
  }
  expect(w.center.log.length).toBe(requests);
  expect(w.offers).toEqual([]);
  // The pool module itself on a skip card: null (the legacy step runs), no center request, no outbox, no row.
  for (const mode of ["off", "observe"] as const) {
    w.setSwitch(mode);
    expect(await centralPoolStep(getTask(w.db, "task-exec")!, { id: "pool-task-exec" } as SchedulerIntent, { maxWorkers: 2, remote: REMOTE })).toBeNull();
  }
  expect(existsSync(join(w.dir, "shared-ledger-v2-lend"))).toBe(false);
  expect(w.center.log.length).toBe(requests);
  expect(w.db.query("SELECT COUNT(*) AS n FROM lend_orders").get()).toEqual({ n: 0 });
  expect(w.observed).toEqual([
    { node: "lend", taskId: "task-exec", attemptKey: "lend:task-exec:s1:r0:a0", code: "would_create_central_order" },
    { node: "lend", taskId: "task-exec-2", attemptKey: "lend:task-exec-2:s1:r0:a0", code: "would_create_central_order" },
  ]);
  w.calls.length = 0;
  const wired: unknown[] = [];
  for (const mode of ["on", "observe", "off"] as const) { w.setSwitch(mode); wired.push(await w.drive("task-local")); }
  expect(wired).toEqual(legacy);
  expect(w.calls).toEqual(legacyCalls);
  expect(w.center.log.length).toBe(requests);
});

test("[验收线 4] the center view claimed: the home row turns claimed; legacy poll / push hand the central order to nobody; a local order is untouched", async () => {
  const w = world(), now = Date.now();
  w.configure();
  expect(await w.drive("task-exec-2")).toMatchObject({ step: "pool_pooled" });
  const made = centralRow(w.db, "task-exec-2")!.orderId;
  writeLendCentralOrder(w.db, "order-local", { taskId: "task-local", project: P, peer: PEER, family: "codex", step: "review", specRev: 1, round: 0,
    head: H, repo: "team/repository", pr: null, wire: { v: 1, orderId: "order-local" }, text: "local", sha256: D, leaseMs: 60_000, createdBy: "scheduler",
    branch: null, base: null }, now);
  w.db.query(`INSERT INTO lend_peers (peer, fp, proto, boot, seq, grant, slots, paused, helloAt) VALUES (?, ?, 2, 'boot', 1, ?, ?, NULL, ?)`)
    .run(PEER, FP, JSON.stringify({ until: now + 3_600_000, roles: ["review", "write"], repos: ["team/repository"], ordersPerDay: 10, ordersLeftToday: 10 }),
      JSON.stringify({ codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }), now);
  const poll = () => pollLend(w.db, PEER, { v: 1, capacity: { families: { codex: 2 }, busy: {}, repos: ["team/repository"], roles: ["review", "write"],
    ordersLeftToday: 5 } } as never, () => ({ peer: PEER, projects: [P], roles: ["review", "write"], maxOpen: 2 }), now).orders.map(o => o.orderId);
  const pushed = () => pushCandidates(w.db, now).map(c => c.summary.orderId);
  // While pooled at the center, the legacy poll / push already skip it (route central); the local order is offered as before.
  expect([poll(), pushed()]).toEqual([["order-local"], ["order-local"]]);
  // Unclaimed at the center: the sync step projects nothing.
  expect(await w.drive("task-exec-2")).toMatchObject({ step: "pool_pooled" });
  expect(getLendOrder(w.db, made)).toMatchObject({ status: "pooled", worker: null });
  const o = w.center.rows().orders.get(made)!;
  const worker = { kind: "peer_agent" as const, instanceId: "peer-b", agentId: "agent-lend-1" };
  expect(w.k.post(ACTORS.executor, w.k.command("lend.claim", { claim: { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, orderId: o.orderId, taskId: o.taskId,
    specRev: o.specRev, round: o.round, head: o.head, leaseGen: o.leaseGen + 1, executorInstanceId: "peer-b", worker, grantId: o.grantId,
    grantDigest: o.grantDigest, claimedAt: 10_000 } })).status).toBe(200);
  expect(await w.drive("task-exec-2")).toMatchObject({ step: "pool_claimed" });
  expect(getLendOrder(w.db, made)).toMatchObject({ status: "claimed", worker: "agent-lend-1", leaseGen: 1 });
  expect(await w.drive("task-exec-2")).toMatchObject({ step: "pool_claimed" }); // replay: nothing moves
  expect([poll(), pushed()]).toEqual([["order-local"], ["order-local"]]);
  expect(getLendOrder(w.db, "order-local")).toMatchObject({ status: "pooled", worker: null, leaseGen: 0 });
  // The switch off: the card is held (skip), still nothing for the legacy dispatch; the local order unchanged.
  w.setSwitch("off");
  expect([poll(), pushed()]).toEqual([["order-local"], ["order-local"]]);
});
