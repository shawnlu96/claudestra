/** S2F2 acceptance lines 1, 2, 3 and 5 (port level, PM 10-11): synthetic ledger + S2C fake center, real S2T transport,
 * S2F's own bindingFor (lendBindings) reading the home row written under the center's order id. */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendBindings, lendCommandOf } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import { getLendOrder, pollLend } from "../src/lib/ledger-lend.js";
import {
  createdLendCentralOrderId, createLendCentralOrder, lendCreateRequestId, type LendCentralCreateDeps, type LendCentralCreateFields,
} from "../src/lib/ledger-lend-central-create.js";
import {
  legacyLendOrders, lendCentralLegacySkip, projectLendCentralClaim, writeLendCentralOrder, type LendCentralHomeOrder,
} from "../src/lib/ledger-lend-central-home.js";
import { LendCentralOutbox } from "../src/lib/ledger-lend-central-state.js";
import { pushCandidates } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { parseCommand, V2ContractError, type V2Actor } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { readStage2Switch, writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import { createStage2Transport, type Stage2Connection } from "../src/lib/shared-ledger-v2-transport.js";
import type { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { ACTORS, EXEC_TASK, featureRows, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const P = "local-project", F = "feature-exec", H = "b".repeat(40), D = "a".repeat(64), PEER = "peerB";
const pair = generateKeyPairSync("ed25519");
const KEY = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const dirs: string[] = [];
let db: Database;
beforeEach(() => { db = openLedger(":memory:"); });
afterEach(() => { closeLedger(":memory:"); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof V2ContractError) return e.code; throw e; }
  return "resolved";
}
/** A fake center with two execution cards under the home's lease, reached through the real signed transport. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "s2f2-")); dirs.push(dir);
  const k = kit(), center = k.center, outboxDir = join(dir, "lend-outbox");
  const second = featureRows(F, "task-exec-2", "execution");
  center.seed({ tasks: [second.task], workflows: [second.workflow] });
  for (const taskId of ["task-exec", "task-exec-2"]) {
    expect(k.post(ACTORS.owner, k.command("lease.acquire", { ...EXEC_TASK, taskId, homeInstanceId: "local" })).status).toBe(200);
  }
  const conn = (actor: V2Actor): Stage2Connection => ({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team",
    personId: actor.personId, instanceId: actor.instanceId, bearer: "s2f2-bearer-secret-0123456789" }, key: KEY, projectId: "project",
    fetch: center.fetch(() => actor) as NonNullable<Stage2Connection["fetch"]> });
  const stage2 = createStage2Transport(conn(ACTORS.owner));
  const transport = stage2.lend(id => lendCommandOf(outboxDir, id));
  let route: "local" | "skip" | "central" = "central", outboxes = 0;
  const deps: LendCentralCreateDeps = { transport, route: () => route, outbox: () => { outboxes++; return new LendCentralOutbox(outboxDir); } };
  const fields = (step: "review" | "write", taskId = "task-exec"): LendCentralCreateFields => ({ ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE,
    ...EXEC_TASK, taskId, featureId: F, family: "codex", step, executorInstanceId: "peer-b", specArtifactId: "artifact", head: H, round: 0,
    branch: step === "write" ? "lend/task-exec-abcd" : null, base: step === "write" ? "main" : null, grantId: "grant", grantDigest: D });
  const sent = (command = "lend.create") => center.log.filter(e => e.command === command).length;
  // S2F's trusted binding source, unchanged: the home row and the center view under one order id, peers, the owner signer.
  const wiring = { transportFor: () => stage2, scope: () => ({ ...V2_FIXTURE_SCOPE }),
    open: () => ({ signer: { personId: "person", instanceId: "local" } }) } as unknown as Stage2Wiring;
  const bindings = lendBindings({ wiring, db: () => db, outboxDir, peer: async name => name === PEER ? { instanceId: "peer-b", fp: "abcd-ef01-2345-6789" } : null });
  const bindingFor = async (orderId: string) => { bindings.bindingFor(orderId); await Bun.sleep(30); return bindings.bindingFor(orderId); };
  return { dir, k, center, outboxDir, stage2, transport, deps, fields, sent, bindingFor, outboxes: () => outboxes,
    setRoute: (v: typeof route) => { route = v; }, setRouteFn: (fn: () => typeof route) => { deps.route = fn; } };
}
const homeRow = (orderId: string, step: "review" | "write", taskId = "task-exec", over: Partial<LendCentralHomeOrder> = {}): LendCentralHomeOrder => ({
  taskId, project: P, peer: PEER, family: "codex", step, specRev: 1, round: 0, head: H, repo: "team/repository", pr: null,
  wire: { v: 1, orderId, taskId, step }, text: `order ${orderId}`, sha256: D, leaseMs: 60_000, createdBy: "scheduler",
  branch: step === "write" ? "lend/task-exec-abcd" : null, base: step === "write" ? "main" : null, ...over });
const dump = () => ({ orders: db.query("SELECT * FROM lend_orders ORDER BY orderId").all(), events: db.query("SELECT * FROM events ORDER BY seq").all() });

test("[验收线 1] one lend.create per home attempt (write, review); the payload parses; the home row under the center id is read by bindingFor", async () => {
  const w = world();
  expect(w.center.rows().orders.size).toBe(0); // before S2F2 nothing on the home ever sent lend.create
  const made: Record<string, string> = {};
  for (const [step, taskId, attempt] of [["write", "task-exec", "lend:task-exec:s1:r0:a0"], ["review", "task-exec-2", "lend:task-exec-2:s1:r0:a0"]] as const) {
    const out = await createLendCentralOrder(attempt, w.fields(step, taskId), w.deps);
    if (out.status !== "confirmed") throw new Error(`not confirmed: ${out.status}`);
    expect(out).toMatchObject({ fresh: true, receipt: { command: "lend.create", requestId: lendCreateRequestId(attempt) } });
    made[step] = out.orderId;
    // The journaled command is the body the center accepted: it passes the contract parser, write carries branch and base.
    const command = lendCommandOf(w.outboxDir, lendCreateRequestId(attempt))!;
    expect(parseCommand(structuredClone(command))).toEqual(command);
    expect(command).toMatchObject({ type: "lend.create", payload: { taskId, step, ...(step === "write" ? { branch: "lend/task-exec-abcd", base: "main" } : { branch: null, base: null }) } });
    expect(w.center.rows().orders.get(out.orderId)).toMatchObject({ status: "pooled", taskId, step, executorInstanceId: "peer-b" });
    expect(createdLendCentralOrderId(attempt, new LendCentralOutbox(w.outboxDir))).toBe(out.orderId);
    // The home row is written under the center's order id, and S2F's bindingFor reads that id back from it.
    expect(writeLendCentralOrder(db, out.orderId, homeRow(out.orderId, step, taskId))).toBe("inserted");
    expect(writeLendCentralOrder(db, out.orderId, homeRow(out.orderId, step, taskId))).toBe("exists");
    expect(getLendOrder(db, out.orderId)).toMatchObject({ orderId: out.orderId, taskId, status: "pooled", step, peer: PEER });
    expect(await w.bindingFor(out.orderId)).toMatchObject({ localProjectId: P, localTaskId: taskId,
      binding: { order: { orderId: out.orderId, step }, peer: PEER, executorInstanceId: "peer-b", homeInstanceId: "local" } });
  }
  expect(w.sent()).toBe(2);
  expect(made.write).not.toBe(made.review);
  expect(w.center.rows().orders.size).toBe(2);
  expect(db.query("SELECT orderId FROM lend_orders ORDER BY orderId").all()).toEqual([made.review, made.write].sort().map(orderId => ({ orderId })));
});

test("[验收线 1] a write order without branch or base never leaves the home; the home row refuses a foreign wire or a second live order", async () => {
  const w = world();
  expect(await code(createLendCentralOrder("lend:task-exec:s1:r0:a0", { ...w.fields("write"), base: null }, w.deps))).toBe("invalid_field");
  expect(w.sent()).toBe(0);
  expect(existsSync(w.outboxDir) ? readdirSync(w.outboxDir).filter(n => n.endsWith(".json")) : []).toEqual([]);
  expect(() => writeLendCentralOrder(db, "order-9", homeRow("lend:task-exec:s1:r0:a0", "review"))).toThrow("invalid_field");
  expect(() => writeLendCentralOrder(db, "order-9", homeRow("order-9", "write", "task-exec", { branch: null }))).toThrow("invalid_field");
  expect(writeLendCentralOrder(db, "order-9", homeRow("order-9", "review"))).toBe("inserted");
  expect(() => writeLendCentralOrder(db, "order-9", homeRow("order-9", "review", "task-exec-2"))).toThrow("conflict");
  expect(() => writeLendCentralOrder(db, "order-10", homeRow("order-10", "review"))).toThrow("conflict");
  expect(db.query("SELECT COUNT(*) AS n FROM lend_orders").get()).toEqual({ n: 1 });
});

test("[验收线 2] off / observe (real S2S switch) and a local route: zero center requests, no outbox, the home ledger byte-identical", async () => {
  const w = world(), state = join(w.dir, "state");
  await writeStage2Release(P, { kind: "release", askId: "ask-release", grantedAt: Date.now() }, state);
  // The frozen rule for an execution card: central only while the effective switch is on, otherwise skip.
  w.setRouteFn(() => readStage2Switch(P, state) === "on" ? "central" : "skip");
  writeLendCentralOrder(db, "order-legacy", homeRow("order-legacy", "review", "task-local"));
  const before = dump(), requests = w.center.log.length;
  for (const mode of ["off", "observe"] as const) {
    await writeStage2Switch(P, mode, state);
    for (const step of ["write", "review"] as const) {
      expect(await createLendCentralOrder(`lend:task-exec:s1:r0:${mode}-${step}`, w.fields(step), w.deps)).toEqual({ status: "held" });
    }
  }
  w.setRouteFn(() => "local");
  expect(await createLendCentralOrder("lend:task-plan:s1:r0:a0", w.fields("review"), w.deps)).toEqual({ status: "local" });
  expect(w.center.log.length).toBe(requests);
  expect(w.outboxes()).toBe(0);
  expect(existsSync(w.outboxDir)).toBe(false);
  expect(dump()).toEqual(before);
  // Same call, switch on: now the center is asked, exactly once.
  w.setRouteFn(() => readStage2Switch(P, state) === "on" ? "central" : "skip");
  await writeStage2Switch(P, "on", state);
  expect((await createLendCentralOrder("lend:task-exec:s1:r0:a0", w.fields("write"), w.deps)).status).toBe("confirmed");
  expect(w.sent()).toBe(1);
  // Withdrawn while a later call is in flight: the route is read again before the center is asked.
  await writeStage2Switch(P, "observe", state);
  expect(await createLendCentralOrder("lend:task-exec-2:s1:r0:a0", w.fields("review", "task-exec-2"), w.deps)).toEqual({ status: "held" });
  expect(w.sent()).toBe(1);
});

test("[验收线 3] crash after lend.create was sent and before the receipt was recorded: recovery only looks the receipt up; a re-offer makes no second order", async () => {
  const w = world(), attempt = "lend:task-exec:s1:r0:a0";
  // The center commits the order, the response never arrives: the process dies with the command journaled, no receipt.
  w.center.inject({ kind: "drop", route: "commands", command: "lend.create" });
  expect(await createLendCentralOrder(attempt, w.fields("write"), w.deps)).toEqual({ status: "outbox", requestId: lendCreateRequestId(attempt) });
  expect(w.sent()).toBe(1);
  expect(w.center.rows().orders.size).toBe(1);
  expect(createdLendCentralOrderId(attempt, new LendCentralOutbox(w.outboxDir))).toBeNull();
  const [centerOrder] = [...w.center.rows().orders.keys()];
  // Restart (a fresh outbox object over the same directory, a new bootId in the caller's fields): receipt lookup, no resend.
  const receipts = () => w.center.log.filter(e => e.route === "receipts").length, looked = receipts();
  const recovered = await createLendCentralOrder(attempt, { ...w.fields("write"), bootId: "boot-after-restart" }, w.deps);
  expect(recovered).toMatchObject({ status: "confirmed", orderId: centerOrder, fresh: false });
  expect([w.sent(), receipts() - looked]).toEqual([1, 1]);
  // The same attempt put up again: answered from the journal, the center is not asked at all.
  const requests = w.center.log.length;
  expect(await createLendCentralOrder(attempt, w.fields("write"), w.deps)).toMatchObject({ status: "confirmed", orderId: centerOrder, fresh: false });
  expect(w.center.log.length).toBe(requests);
  expect(w.center.rows().orders.size).toBe(1);
  // An attempt key never changes card or step.
  expect(await code(createLendCentralOrder(attempt, w.fields("review", "task-exec-2"), w.deps))).toBe("dedup_mismatch");
  expect(w.center.rows().orders.size).toBe(1);
});

test("[验收线 3] center unreachable before commit: the journaled command goes out once it is reachable, still one order; a refusal leaves no journal", async () => {
  const w = world(), attempt = "lend:task-exec:s1:r0:a0";
  w.center.inject({ kind: "unavailable", route: "commands", command: "lend.create" });
  expect((await createLendCentralOrder(attempt, w.fields("review"), w.deps)).status).toBe("outbox");
  expect(w.center.rows().orders.size).toBe(0);
  const out = await createLendCentralOrder(attempt, w.fields("review"), w.deps);
  expect(out).toMatchObject({ status: "confirmed", fresh: true });
  expect(w.center.rows().orders.size).toBe(1);
  // Refused by the center (stale workflow version): no order, no journal entry, and a current command may follow.
  const other = "lend:task-exec-2:s1:r0:a0", stale = { ...w.fields("review", "task-exec-2"), expectedWorkflowRev: 9 };
  expect(await code(createLendCentralOrder(other, stale, w.deps))).toBe("conflict");
  expect(lendCommandOf(w.outboxDir, lendCreateRequestId(other))).toBeNull();
  expect((await createLendCentralOrder(other, w.fields("review", "task-exec-2"), w.deps)).status).toBe("confirmed");
  expect(w.center.rows().orders.size).toBe(2);
});

test("[验收线 5] after the center confirmed the claim the home row is claimed; legacy poll / push hand a central order to nobody; local orders are untouched", async () => {
  const w = world(), now = Date.now();
  const made = await createLendCentralOrder("lend:task-exec:s1:r0:a0", w.fields("review"), w.deps);
  if (made.status !== "confirmed") throw new Error("not confirmed");
  writeLendCentralOrder(db, made.orderId, homeRow(made.orderId, "review"), now);
  writeLendCentralOrder(db, "order-local", homeRow("order-local", "review", "task-local"), now);
  db.query(`INSERT INTO lend_peers (peer, fp, proto, boot, seq, grant, slots, paused, helloAt) VALUES (?, 'abcd-ef01-2345-6789', 2, 'boot', 1, ?, ?, NULL, ?)`)
    .run(PEER, JSON.stringify({ until: now + 3_600_000, roles: ["review", "write"], repos: ["team/repository"], ordersPerDay: 10, ordersLeftToday: 10 }),
      JSON.stringify({ codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }), now);
  const route = (taskId: string) => taskId === "task-local" ? "local" as const : "central" as const;
  const poll = () => pollLend(db, PEER, { v: 1, capacity: { families: { codex: 2 }, busy: {}, repos: ["team/repository"], roles: ["review", "write"],
    ordersLeftToday: 5 } } as never, () => ({ peer: PEER, projects: [P], roles: ["review", "write"], maxOpen: 2 }), now).orders;
  const pushed = () => pushCandidates(db, now);
  // The predicate: a central (or held) order is skipped by the legacy poll / push; a local order's result is unchanged.
  expect(lendCentralLegacySkip({ taskId: "task-exec" }, route)).toBe(true);
  expect(lendCentralLegacySkip({ taskId: "task-exec" }, () => "skip")).toBe(true);
  expect(lendCentralLegacySkip({ taskId: "task-local" }, route)).toBe(false);
  const polled = poll(), candidates = pushed();
  expect(polled.map(o => o.orderId).sort()).toEqual([made.orderId, "order-local"].sort());
  expect(legacyLendOrders(polled, route)).toEqual(polled.filter(o => o.orderId === "order-local"));
  expect(legacyLendOrders(candidates.map(c => ({ ...c, taskId: c.summary.taskId })), route).map(c => c.summary.orderId)).toEqual(["order-local"]);
  expect(candidates.map(c => c.summary.orderId).sort()).toEqual([made.orderId, "order-local"].sort());
  expect(legacyLendOrders(polled, () => "local")).toEqual(polled);
  // The center confirms the lender's claim.
  const binding = (await w.bindingFor(made.orderId))!.binding, worker = { kind: "peer_agent" as const, instanceId: "peer-b", agentId: "agent-lend-1" };
  const pooledView = await w.transport.view(made.orderId);
  expect(() => projectLendCentralClaim(db, binding, pooledView)).toThrow("stale_order"); // not claimed at the center: nothing projected
  const o = pooledView.order;
  const claim = w.k.post(ACTORS.executor, w.k.command("lend.claim", { claim: { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, orderId: o.orderId, taskId: o.taskId,
    specRev: o.specRev, round: o.round, head: o.head, leaseGen: o.leaseGen + 1, executorInstanceId: "peer-b", worker, grantId: o.grantId,
    grantDigest: o.grantDigest, claimedAt: 10_000 } }));
  expect(claim.status).toBe(200);
  const view = await w.transport.view(made.orderId);
  expect(projectLendCentralClaim(db, binding, view, now)).toBe(true);
  expect(getLendOrder(db, made.orderId)).toMatchObject({ status: "claimed", worker: "agent-lend-1", leaseGen: 1, leaseUntil: view.lease!.expiresAt });
  expect(projectLendCentralClaim(db, binding, view, now)).toBe(false); // replay: already projected
  expect(() => projectLendCentralClaim(db, { ...binding, executorInstanceId: "peer-a" }, view)).toThrow("forbidden");
  // Legacy poll / push now dispatch this execution order zero times; the non-central order is exactly as before.
  expect(poll()).toEqual(polled.filter(x => x.orderId === "order-local"));
  expect(pushed()).toEqual(candidates.filter(c => c.summary.orderId === "order-local"));
  expect(getLendOrder(db, "order-local")).toMatchObject({ status: "pooled", worker: null, leaseGen: 0 });
  // A settled row is never moved back.
  db.query("UPDATE lend_orders SET status = 'done' WHERE orderId = ?").run(made.orderId);
  expect(projectLendCentralClaim(db, binding, view, now)).toBe(false);
  expect(getLendOrder(db, made.orderId)!.status).toBe("done");
});
