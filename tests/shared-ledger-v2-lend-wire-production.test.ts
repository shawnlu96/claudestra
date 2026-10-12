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
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { configureLendCentralPool, lendCentralPoolPort } from "../src/lib/ledger-lend-central-pool.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { drivePool } from "../src/lib/scheduler-pool-tick.js";
import { configureSchedulerV2Pass } from "../src/lib/scheduler-v2-pass.js";
import type { V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
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

function world() {
  const dir = mkdtempSync(join(tmpdir(), "s2f6-prod-")); dirs.push(dir);
  const path = join(dir, "ledger.sqlite"); dbs.push(path);
  const db: Database = openLedger(path);
  let now = 1000;
  const at = (actor: string) => ({ actor, now: now += 10 });
  createTask(db, at("owner"), { project: P, id: T, title: T, kind: "code", agent: "agent-one", extra: { sharedFeatureId: "feature-exec" } });
  setWorkflow(db, at("owner"), { taskId: T, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  const spec = join(dir, "T1.md");
  writeFileSync(spec, `规格：只改 src/lib/x.ts，起点是提交 ${SHA}\n验收：单测全绿`);
  db.run("UPDATE tasks SET spec = ?, stage = 'build' WHERE id = ?", [spec, T]);
  recordHello(db, PEER, null, { v: 1, proto: 2, boot: "boot", seq: 1, slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null,
    grant: { until: Date.now() + 3_600_000, roles: ["review", "write"], repos: [REPO], ordersPerDay: 50, ordersLeftToday: 50 } }, Date.now());
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { "feature-exec": { authorityMode: "execution", sharedPlanning: true,
    centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: "feature-exec", epoch: 1 } } } }));
  configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
  const k = kit(), center = k.center, rows = featureRows("feature-exec", T, "execution");
  center.seed({ tasks: [rows.task], workflows: [rows.workflow] });
  expect(k.post(ACTORS.owner, k.command("lease.acquire", { ...EXEC_TASK, taskId: T, homeInstanceId: "local" })).status).toBe(200);
  const conn = (actor: V2Actor): Stage2Connection => ({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team",
    personId: actor.personId, instanceId: actor.instanceId, bearer: "s2f6-bearer-secret-0123456789" }, key: KEY, projectId: "project",
    fetch: center.fetch(() => actor) as NonNullable<Stage2Connection["fetch"]> });
  const stage2 = createStage2Transport(conn(ACTORS.owner));
  const task = rows.task as typeof rows.task & { spec: Record<string, unknown> };
  const view = { tasks: [{ ...task, spec: { ...task.spec, artifactId: "artifact" } }], workflows: [rows.workflow] };
  const wiring = { dir, transportFor: () => stage2, mode: () => "on", observe: () => {}, scope: () => ({ ...V2_FIXTURE_SCOPE }),
    featureOfTask: () => ({ localFeatureId: "feature-exec", projectId: "project", centerFeatureId: "feature-exec", epoch: 1 }),
    cachedView: () => view } as unknown as Stage2Wiring;
  const remote: { main: RemoteHead } = { main: { ok: true, head: "b".repeat(40) } };
  const port = lendCentralPoolPort({ wiring, db: () => db, fence: () => V2_FIXTURE_FENCE, instanceId: () => "local",
    peer: async (name) => name === PEER ? { instanceId: "peer-b", fp: FP } : null, remoteHead: async () => remote.main, borrow: async () => BORROW });
  configureLendCentralPool(port);
  const calls: string[][] = [];
  const intent = { id: "pool-T1", taskId: T, recipient: `peer:${PEER}`, action: "dispatch" } as SchedulerIntent;
  const drive = () => drivePool({ manager: async (...args: string[]) => { calls.push(args); return { ok: true, outcome: "pooled" }; },
    notifyPm: async () => {}, lost: () => (e) => { throw e; }, db: null }, getTask(db, T)!, intent, 2, REMOTE);
  const homeRow = () => db.query("SELECT orderId, head, branch, base, text FROM lend_orders WHERE taskId = ?").get(T) as
    { orderId: string; head: string; branch: string; base: string; text: string } | null;
  return { db, center, port, drive, calls, remote, homeRow, intent };
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
  w.db.run(`INSERT INTO events (project, target, kind, actor, ts, text, data) VALUES (?, ?, 'review', 'rv', 2000, 'changes', ?)`,
    [P, T, JSON.stringify({ path: report, findings: [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "[验收线 1] race" }] })]);
  const offer = await w.port.offer(getTask(w.db, T)!, w.intent, "lend:T1:s1:r1:a0", { maxWorkers: 2, remote: REMOTE }, null);
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
