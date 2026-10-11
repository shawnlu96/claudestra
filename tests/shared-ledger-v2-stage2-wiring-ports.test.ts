/**
 * S2F r1 fixes, port by port, over the S2C fake center behind the real S2T transport:
 * the S2R task-lease adapter (E6 / E11), the pre-pass with the switch off, the pass hooks (S2J gh wrapper + merging-row
 * recovery, S2M submit hook, the pass guard) and the S2L trusted binding / shared result / outbox receipt lookup (E1, E16 ③).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTask } from "../src/lib/ledger-write.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import type { CiBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { V2DeployHeld } from "../src/lib/scheduler-v2-deploy.js";
import { SchedulerV2MergeWait } from "../src/lib/scheduler-v2-merge.js";
import type { DeployRun } from "../src/lib/scheduler-deploy.js";
import { stage2LeaseAdapter } from "../src/lib/scheduler-v2-wiring-lease.js";
import { schedulerV2PassOpts, type SchedulerV2PassHooks } from "../src/lib/scheduler-v2-wiring-pass.js";
import { V2ContractError, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import { initSharedLedgerV2 } from "../src/bridge/shared-ledger-v2-wiring.js";
import { openLendCentral } from "../src/bridge/shared-ledger-v2-lend.js";
import { lendCommandOf } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import { commands, F, fixture, memberCards, P, until, resetWorld, world } from "./shared-ledger-v2-stage2-wiring-world.test.js";

beforeEach(resetWorld);
afterEach(resetWorld);

const feature = { localFeatureId: F, projectId: P, homeInstanceId: "local",
  centerExecution: { centerId: "center", ...V2_FIXTURE_SCOPE, centerFeatureId: F, epoch: 1 } };
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => e instanceof V2ContractError ? e.code : String(e));

test("S2R adapter: one feature lease = every workflow card's task lease; receipts give centerNow; transient vs lost", async () => {
  const s = await world();
  await s.w.stop(); // the daemon's own loop releases its leases; this test drives the adapter directly
  const adapter = stage2LeaseAdapter(s.wiring, () => "local"), leases = () => [...s.k.center.rows().leases.values()];
  const got = await adapter.command(feature, "lease.acquire", "boot-a", null);
  expect(got).toEqual({ fence: { serviceGeneration: 1, epoch: 1, bootId: "boot-a" }, centerNow: 10_000, renewedAt: 10_000, expiresAt: 70_000 });
  expect(leases().map((l) => [l.taskId, l.bootId])).toEqual([["task-exec", "boot-a"]]);
  // A card that got a workflow later joins at the next renewal; the shortest card lease bounds the feature.
  const { T } = await memberCards(s);
  s.k.center.advance(15_000);
  const renewed = await adapter.command(feature, "lease.renew", "boot-a", got!.fence);
  expect(renewed).toMatchObject({ centerNow: 25_000, renewedAt: 25_000, expiresAt: 85_000 });
  expect(leases().map((l) => l.taskId).sort()).toEqual([T, "task-exec"].sort());
  // Another boot while this one holds: not a lost term, just "not now" (S2R backs off).
  expect(await code(adapter.command(feature, "lease.acquire", "boot-b", null))).toBe("unavailable");
  // Past the center expiry the renewal is lease_expired: S2R loses the feature and never re-acquires that term.
  s.k.center.advance(61_000);
  expect(await code(adapter.command(feature, "lease.renew", "boot-a", got!.fence))).toBe("lease_expired");
  const fresh = await adapter.command(feature, "lease.acquire", "boot-c", null);
  await adapter.command(feature, "lease.release", "boot-c", fresh!.fence);
  expect(leases()).toEqual([]);
  // The center says another home: lost, not transient.
  expect(await code(stage2LeaseAdapter(s.wiring, () => "elsewhere").command(feature, "lease.acquire", "boot-d", null))).toBe("wrong_home");
});

test("switch off: the daemon's pass makes no center request (no projection, no lease)", async () => {
  const s = await world();
  await until(() => s.w.leases.current(F) !== null);
  await writeStage2Switch(P, "off", s.dir);
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(s.requests.slice(before)).toEqual([]);
  expect(s.w.leases.current(F)).toBeNull();
});

test("E13: every central port reads skip under off / observe / a revoked release / migrating, and no center request is made", async () => {
  const s = await world();
  await until(() => s.w.leases.current(F) !== null);
  await s.pass(); // projects task-exec
  const route = () => s.w.route("task-exec"), before = s.requests.length;
  expect(route()).toBe("central");
  for (const mode of ["off", "observe"] as const) {
    await writeStage2Switch(P, mode, s.dir);
    expect(route()).toBe("skip");
  }
  await writeStage2Switch(P, "on", s.dir);
  await writeStage2Release(P, null, s.dir); // revoked: the effective switch is off at the next check
  expect(route()).toBe("skip");
  await writeStage2Release(P, { kind: "drill", askId: "ask-exec", grantedAt: Date.now(), expiresAt: Date.now() + 3600_000 }, s.dir);
  expect(route()).toBe("central");
  const modes = join(s.dir, "shared-ledger-modes.json"), mode = JSON.parse(readFileSync(modes, "utf8"));
  mode.features[F].migrating = { batchId: "b", kind: "home" };
  writeFileSync(modes, JSON.stringify(mode), { mode: 0o600 });
  await Bun.sleep(5); // the S2D mode cache keys on mtime
  expect(route()).toBe("skip");
  expect(s.requests.slice(before)).toEqual([]);
});

function passHooks(s: Awaited<ReturnType<typeof world>>, route: "local" | "central") {
  const observed: Record<string, unknown>[] = [];
  const hooks: SchedulerV2PassHooks = { db: () => s.db, route: () => route, deployment: async () => null, observe: (e) => observed.push(e) };
  return { observed, opts: schedulerV2PassOpts(hooks, { ...s.opts, external: () => base }) };
}
const gh: string[] = [];
const ciBehind = { updateBranch: async (repo: string, pull: string) => { gh.push(`update ${repo}#${pull}`); } } as unknown as CiBehindGh;
const base = { inspect: async (pr: string) => { gh.push(`inspect ${pr}`); return { state: "MERGED", mergeSha: "a".repeat(40) }; },
  ciBehind } as unknown as MergeExternal;

function mergingRow(s: Awaited<ReturnType<typeof world>>, pr: string) {
  createTask(s.db, { actor: "owner" }, { id: "L", project: "local-p", title: "local", kind: "code" });
  s.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('m1','L','local-p','merge_deploy','merge',0,1,1,2,'submitted','',1,1)`).run();
  s.db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
    VALUES ('m1','L','local-p',?,'b','${"b".repeat(40)}','ci','merging',1,1)`).run(pr);
}

test("S2J hooks: the driver's ciBehind gh is wrapped; a central merging row is reconciled before inspect (held = no gh)", async () => {
  const s = await world(), pr = "https://github.com/o/r/pull/7";
  mergingRow(s, pr);
  const local = passHooks(s, "local").opts.external!({ repoDir: s.dir } as never) as MergeExternal & { ciBehind?: CiBehindGh };
  gh.length = 0;
  expect(await local.inspect(pr)).toMatchObject({ state: "MERGED" }); // local route: stage one, byte for byte
  await local.ciBehind!.updateBranch("o/r", "7", "c".repeat(40)); // no stage-two task for this PR: the legacy gh
  expect(gh).toEqual([`inspect ${pr}`, "update o/r#7"]);
  // Central: the merge port cannot bind the intent (no projected center intent) → wait; the driver records unknown, gh untouched.
  const central = passHooks(s, "central").opts.external!({ repoDir: s.dir } as never);
  gh.length = 0;
  await expect(central.inspect(pr)).rejects.toBeInstanceOf(SchedulerV2MergeWait);
  expect(gh).toEqual([]);
});

test("S2M hook and pass guard: a central deploy without a bound deployment is held before any write; gh/launchctl need the pass guard", async () => {
  const s = await world();
  const { opts, observed } = passHooks(s, "central");
  const jobs = opts.deployJobs!;
  const run = { intentId: "d1", taskId: "L", project: P, prRef: "pr", mergeSha: "a".repeat(40), phase: "running", rev: 1,
    label: null, outcome: null, liveness: null, receipt: null, reason: null, deployedAt: null, createdAt: 1, updatedAt: 1 } as DeployRun;
  const held = { ...run, label: jobs.label(run) };
  await expect(jobs.submit(held, s.dir, { restartLabels: ["x"], timeoutMs: 1000 } as never)).rejects.toBeInstanceOf(V2DeployHeld);
  expect(observed).toEqual([{ node: "deploy", taskId: "L", intentId: "d1", route: "central", outcome: "held", reason: "unavailable" }]);
  // The spawn guard is the pass's own `active`, armed by the train tick (which schedulerPass runs first).
  const local = passHooks(s, "local").opts;
  const command = async () => (local.deployJobs as unknown as { observe(r: DeployRun): Promise<unknown> }).observe({ ...held });
  await expect(command()).rejects.toBeInstanceOf(SchedulerStopped);
  // Armed with a pass whose lease is gone: the same spawn is refused by that pass's own guard.
  await local.trainTick!(s.db, [], () => { throw new SchedulerStopped("maintenance lease lost"); }, undefined);
  await expect(command()).rejects.toThrow("maintenance lease lost");
});

test("S2L: a fresh central order binds from trusted home records only; result is the fixed projection; requestId via the outbox", async () => {
  const s = await world();
  await until(() => s.w.leases.current(F) !== null);
  await s.pass(); // project task-exec (the order's card) locally
  const fence = s.w.leases.current(F)!;
  // The center order is created the way S2F2 will (PM 04:2x ④): straight on the fake center, under the home's lease.
  const lend = s.k.post(s.owner, s.k.command("lend.create", { ...fixture("lend.create"), taskId: "task-exec", featureId: F,
    expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1, executorInstanceId: "peer-b" }, fence));
  expect(lend.status).toBe(200);
  const orderId = (lend.body as { result: { entityId: string } }).result.entityId;
  // The home's own lend order (same id), written the way the home lend path records it.
  s.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256,
    status, leaseMs, createdBy, createdAt, updatedAt) VALUES (?, 'task-exec', ?, 'peerB', 'codex', 'review', 1, 0, ?, 'team/repository', NULL,
    '{}', 't', 'x', 'pooled', 60000, 'owner', 1, 1)`).run(orderId, P, "b".repeat(40));
  const outboxDir = join(s.dir, "lend-outbox");
  initSharedLedgerV2({ dir: s.dir, db: () => s.db, wiring: s.wiring, outboxDir,
    lendPeer: async (name) => name === "peerB" ? { instanceId: "peer-b", fp: "abcd-ef01-2345-6789" } : null });
  // First call primes the center lend view + peer registry and holds (unavailable); nothing pinned yet.
  expect(await code(openLendCentral(orderId, "task-exec"))).toBe("unavailable");
  await Bun.sleep(50);
  const bound = await openLendCentral(orderId, "task-exec");
  expect(bound!.entry).toMatchObject({ localProjectId: P, localTaskId: "task-exec", binding: { peer: "peerB", fp: "abcd-ef01-2345-6789",
    executorInstanceId: "peer-b", homeInstanceId: "local", order: { orderId },
    actor: { kind: "service", personId: "person", instanceId: "local", orderId, actions: ["lend.claim", "lend.renew", "lend.result"] } } });
  expect(bound!.sharedResult()).toEqual({ summary: expect.stringContaining(orderId), artifactIds: [] });
  // X9's requestId lookup resolves only commands journaled in S2L's outbox.
  mkdirSync(outboxDir, { recursive: true });
  const journaled = s.k.command("lend.cancel", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1,
    orderId, leaseGen: 0, reason: "x" }, fence) as V2Command;
  writeFileSync(join(outboxDir, "k.json"), JSON.stringify({ command: journaled }));
  expect(lendCommandOf(outboxDir, journaled.requestId)).toEqual(journaled);
  expect(lendCommandOf(outboxDir, "other")).toBeNull();
  expect(commands(s.requests).filter((c) => c === "lend.create")).toEqual([]); // the home never creates center orders (S2F2)
});
