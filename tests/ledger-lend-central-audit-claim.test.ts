/** S2LC1 (audit A05-08 / A05-09): the public central lend client against a center that checks generations.
 * World: the S2C fake center (receipts, dedup, drop / 503 faults, draft transactions) behind the real S2T transport, with the lend
 * handlers below standing in for the center domain: a natively created order is pooled at generation 0, a claim must ask for the
 * next one, renew / result must carry the claimed one, a new write's task may have no head. The binding is assembled from the
 * center's pooled view the way the bridge does it. No fixture starts claimed, no mock skips the generation check.
 * Acceptance line 5 uses this fake with CLCAS1 semantics (a step assigned to another executor refuses the claim); the real
 * center domain replaces it once CLCAS1 is merged. Synthetic ledger, temp dirs and fake ports only. */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendCommandOf } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { LedgerLendCentralClient, type LendCentralTransport } from "../src/lib/ledger-lend-central.js";
import type { LendCentralBinding, LendCentralGrantDeps, LendCentralView } from "../src/lib/ledger-lend-central-checks.js";
import { projectLendCentralClaim, writeLendCentralOrder } from "../src/lib/ledger-lend-central-home.js";
import { LendCentralOutbox } from "../src/lib/ledger-lend-central-state.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { LendEntry, LendRead } from "../src/lib/lend-config.js";
import {
  assertFence, fail, v2ObjectDigest, type V2Actor, type V2Fence, type V2LendOrder, type V2Step, type V2Task,
} from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { createStage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import type { CommandHandlers } from "./helpers/shared-ledger-v2-fake-center-commands.js";
import { ACTORS, featureRows, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";
import { executionAt, must, requireLease, type FakeCenterState } from "./helpers/shared-ledger-v2-fake-center-state.js";

const H = "b".repeat(40), OTHER = "c".repeat(40), NEW = "d".repeat(40), D = "a".repeat(64), PEER = "peerB", FP = "f".repeat(64);
const WORKER = { kind: "peer_agent" as const, instanceId: "peer-b", agentId: "agent-lend-1" };
const RIVAL = { kind: "peer_agent" as const, instanceId: "peer-a", agentId: "agent-rival" };
const STAGE = { write: "build", fix: "fix", review: "review" } as const;
type Step = keyof typeof STAGE;
const pair = generateKeyPairSync("ed25519");
const KEY = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const dirs: string[] = [], ledgers: string[] = [];
afterEach(() => {
  for (const path of ledgers.splice(0)) closeLedger(path);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fence = (f: V2Fence): V2Fence => ({ serviceGeneration: f.serviceGeneration, epoch: f.epoch, bootId: f.bootId });
/** The lend commands reach the center through the home's order-scoped lend service, never as another order's or a person. */
function lendService(actor: V2Actor, order: V2LendOrder, type: string): void {
  if (actor.kind !== "service" || actor.orderId !== order.orderId || !actor.actions.includes(type as never)
    || actor.instanceId !== order.homeInstanceId) fail("forbidden");
}
/** The task an order may still be worked on: same versions and stage; its head is the order's, or unset for a new write. */
function orderTask(state: FakeCenterState, order: V2LendOrder): V2Task {
  const t = must(state.tasks.get(order.taskId));
  if (t.specRev !== order.specRev || t.round !== order.round || t.stage !== STAGE[order.step]
    || !(t.head === order.head || (order.step === "write" && t.head === null))) fail("stale_order");
  return t;
}
function claimedOrder(state: FakeCenterState, orderId: string, gen: number, executor: string, now: number): V2LendOrder {
  const order = must(state.orders.get(orderId)), lease = state.lendLeases.get(orderId);
  if (order.status !== "claimed") fail("stale_order");
  if (gen !== order.leaseGen || !lease || lease.leaseGen !== gen) fail("stale_lease_gen");
  if (executor !== order.executorInstanceId) fail("forbidden");
  if (lease.expiresAt <= now) fail("lease_expired");
  return order;
}
const DOMAIN: CommandHandlers = {
  "lend.claim": ({ state, command, actor, now }) => {
    const claim = command.payload.claim, order = must(state.orders.get(claim.orderId));
    lendService(actor, order, "lend.claim");
    if (order.status !== "pooled") fail("stale_order");
    // CLCAS1: a step.assign that handed this step to someone else outranks a pooled claim arriving after it.
    const assigned = state.steps.find(s => s.taskId === order.taskId && s.step === order.step && s.round === order.round && s.state === "assigned");
    if (assigned && v2ObjectDigest(assigned.executor) !== v2ObjectDigest(claim.worker)) fail("stale_order");
    if (claim.leaseGen !== order.leaseGen + 1) fail("stale_lease_gen");
    if (claim.taskId !== order.taskId || claim.specRev !== order.specRev || claim.round !== order.round || claim.head !== order.head
      || claim.grantId !== order.grantId || claim.grantDigest !== order.grantDigest) fail("stale_order");
    assertFence(fence(order), fence(claim));
    if (order.executorInstanceId !== null && order.executorInstanceId !== claim.executorInstanceId) fail("forbidden");
    orderTask(state, order);
    const leaseUntil = now + order.leaseMs;
    state.orders.set(order.orderId, { ...order, status: "claimed", leaseGen: claim.leaseGen, executorInstanceId: claim.executorInstanceId,
      worker: claim.worker, leaseUntil, updatedAt: now });
    state.lendLeases.set(order.orderId, { teamId: order.teamId, projectId: order.projectId, orderId: order.orderId, taskId: order.taskId,
      ...fence(order), leaseGen: claim.leaseGen, executorInstanceId: claim.executorInstanceId, worker: claim.worker, renewedAt: now,
      expiresAt: leaseUntil, leaseMs: order.leaseMs });
    return { entityId: order.orderId, rev: claim.leaseGen };
  },
  "lend.renew": ({ state, command, actor, now }) => {
    const p = command.payload, order = claimedOrder(state, p.orderId, p.leaseGen, p.executorInstanceId, now);
    lendService(actor, order, "lend.renew");
    assertFence(fence(order), fence(command));
    orderTask(state, order);
    const leaseUntil = now + order.leaseMs;
    state.orders.set(order.orderId, { ...order, leaseUntil, updatedAt: now });
    state.lendLeases.set(order.orderId, { ...must(state.lendLeases.get(order.orderId)), renewedAt: now, expiresAt: leaseUntil });
    return { entityId: order.orderId, rev: order.leaseGen };
  },
  "lend.result": ({ state, command, actor, now }) => {
    const r = command.payload.result, order = claimedOrder(state, r.orderId, r.leaseGen, r.executorInstanceId, now);
    lendService(actor, order, "lend.result");
    if (v2ObjectDigest(r.worker) !== v2ObjectDigest(order.worker)) fail("forbidden");
    if (r.taskId !== order.taskId || r.specRev !== order.specRev || r.round !== order.round || r.expectedHead !== order.head) fail("stale_order");
    assertFence(fence(order), fence(r));
    orderTask(state, order);
    state.orders.set(order.orderId, { ...order, status: "done", resultDigest: r.resultDigest, resultOperationId: r.operationId,
      leaseUntil: null, updatedAt: now });
    state.lendLeases.delete(order.orderId);
    return { entityId: order.orderId, rev: order.leaseGen, specRev: order.specRev };
  },
  "lend.cancel": ctx => {
    const { state, command, now } = ctx, p = command.payload, order = must(state.orders.get(p.orderId));
    executionAt(ctx, p);
    if (!["pooled", "claimed"].includes(order.status) || p.leaseGen !== order.leaseGen) fail("stale_order");
    state.orders.set(order.orderId, { ...order, status: "cancelled", leaseUntil: null, updatedAt: now });
    state.lendLeases.delete(order.orderId);
    return { entityId: order.orderId, rev: order.leaseGen + 1 };
  },
  "step.assign": ctx => {
    const { state, command, now } = ctx, p = command.payload;
    executionAt(ctx, p); requireLease(state, p.taskId, command, now);
    const step: V2Step = { ...(structuredClone(V2_DTO_FIXTURES.step.valid) as V2Step), taskId: p.taskId, step: p.step, round: p.round,
      executor: p.executor, state: "assigned", rev: 1, createdAt: now, updatedAt: now };
    state.steps.push(step);
    return { entityId: p.taskId, rev: 1 };
  },
};

/** One execution task and its natively created (pooled, generation 0) order; the binding is read from the center's pooled view. */
async function world(step: Step = "write", taskHead: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "s2lc1-")); dirs.push(dir);
  const k = kit({ handlers: DOMAIN }), center = k.center, taskId = "task-lc";
  const rows = featureRows("feature-exec", taskId, "execution");
  const versions = { taskId, expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1 };
  center.seed({ tasks: [{ ...rows.task, stage: STAGE[step], head: taskHead, pr: null }], workflows: [rows.workflow] });
  expect(k.post(ACTORS.owner, k.command("lease.acquire", { ...versions, homeInstanceId: "local" })).status).toBe(200);
  const made = k.post(ACTORS.owner, k.command("lend.create", { ...versions, featureId: "feature-exec", family: "codex", step,
    executorInstanceId: "peer-b", specArtifactId: "artifact", head: H, round: 0, branch: step === "review" ? null : "lend/task-lc-abcd",
    base: step === "review" ? null : "main", grantId: "grant", grantDigest: D }));
  expect(made.status).toBe(200);
  const orderId = (made.body as { result: { entityId: string } }).result.entityId;
  const order = () => center.rows().orders.get(orderId)!;
  expect(order()).toMatchObject({ status: "pooled", leaseGen: 0, head: H, worker: null });

  const actor: V2Actor = { kind: "service", personId: "person", instanceId: "local", serviceId: "lend", representedPersonId: "person",
    orderId, projects: ["project"], actions: ["lend.claim", "lend.renew", "lend.result"] };
  const stage2 = createStage2Transport({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team",
    personId: "person", instanceId: "local", bearer: "s2lc1-bearer-secret-0123456789" }, key: KEY, projectId: "project",
    fetch: center.fetch(() => actor) as never });
  const transport: LendCentralTransport = stage2.lend(id => lendCommandOf(dir, id));
  let afterView: (() => void) | null = null;
  const racing: LendCentralTransport = { ...transport,
    view: async id => { const v = await transport.view(id); const hook = afterView; afterView = null; hook?.(); return v; } };
  const entry: LendEntry = { peer: PEER, fp: FP, families: { codex: 2 }, roles: ["review", "write"], repos: [order().repository],
    ordersPerDay: 10, grantedAt: new Date(1000).toISOString(), until: new Date(100_000_000).toISOString() };
  const read: LendRead = { status: "ok", file: { version: 2, enabled: true, lend: [entry], borrow: [] } };
  const grant: LendCentralGrantDeps = { now: () => center.time, readLend: async () => read,
    context: async () => ({ contacts: [{ name: PEER, fp: FP }], projects: [] }) };
  // The bridge's bindingFor: the center's order as it is when the claim arrives (pooled), the peer registry, the owner's signer.
  const pooled = await transport.view(orderId) as LendCentralView;
  const binding: LendCentralBinding = { order: pooled.order, worker: WORKER, executorInstanceId: "peer-b", peer: PEER, fp: FP,
    homeInstanceId: "local", actor };
  const client = () => new LedgerLendCentralClient(binding, racing, grant, new LendCentralOutbox(dir));
  const sent = (type: string, status?: number | "dropped") =>
    center.log.filter(e => e.command === type && (status === undefined || e.status === status)).length;
  const deliver = { v: 1, orderId, gen: 1, deliver: { v: 1, orderId, head: NEW, evidence: "evidence.md", summary: "summary", selfCheck: "checks" },
    branch: "lend/task-lc-abcd", pr: null, session: { id: "worker-session", family: "codex" } };
  const verdict = { v: 1, orderId, gen: 1, verdict: { v: 1, orderId, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [],
    reportPath: "report.md" }, report: "report", session: { id: "worker-session", family: "codex" } };
  return { dir, k, center, taskId, versions, orderId, order, binding, client, sent, read, entry, deliver, verdict,
    claimWire: { v: 1, orderId, worker: WORKER.agentId },
    beat: (gen = 1) => ({ v: 1, orders: [{ orderId, gen, phase: "working", lastActivityAt: center.time, excerpt: "" }] }),
    view: () => transport.view(orderId) as Promise<LendCentralView>,
    race: (hook: () => void) => { afterView = hook; },
    cancel: () => expect(k.post(ACTORS.owner, k.command("lend.cancel", { ...versions, orderId, leaseGen: order().leaseGen, reason: "停止" })).status).toBe(200),
    drift: () => center.seed({ tasks: [{ ...center.rows().tasks.get(taskId)!, specRev: 2 }] }),
    revoke: () => { read.file.enabled = false; },
  };
}
type World = Awaited<ReturnType<typeof world>>;
/** The bridge's delivery order: preflight, the publish port (which re-reads live() right before each effect), then result. */
async function deliverFlow(w: World, log: string[]) {
  const client = w.client();
  log.push("preflight"); await client.preflight(w.deliver);
  await client.live(); log.push("publish");
  log.push("result");
  return client.result(w.deliver, { summary: "approved", artifactIds: [] });
}

test("[验收线 1] 原生 create 的 pooled gen=0:公共 client 发 gen=1,中心域接受,主场投影已领代为 1", async () => {
  const w = await world("review", H);
  const outcome = await w.client().claim(w.claimWire);
  expect(outcome).toMatchObject({ status: "confirmed", freshClaim: true });
  expect(w.sent("lend.claim")).toBe(1);
  expect(w.order()).toMatchObject({ status: "claimed", leaseGen: 1, executorInstanceId: "peer-b", worker: WORKER });
  expect(w.center.rows().lendLeases.get(w.orderId)).toMatchObject({ leaseGen: 1, worker: WORKER });
  // The home projection of the claim (E16 ②) from the center's view, bound by the same pooled-pinned binding.
  const path = join(w.dir, "ledger.sqlite"); ledgers.push(path);
  const db: Database = openLedger(path);
  createTask(db, { actor: "owner", now: 1000 }, { project: "p", id: w.taskId, title: "t", kind: "code" });
  writeLendCentralOrder(db, w.orderId, { taskId: w.taskId, project: "p", peer: PEER, family: "codex", step: "review", specRev: 1, round: 0,
    head: H, repo: "team/repository", pr: null, wire: { v: 1, orderId: w.orderId }, text: "order", sha256: D, leaseMs: 60_000,
    createdBy: "scheduler", branch: null, base: null });
  expect(getLendOrder(db, w.orderId)).toMatchObject({ status: "pooled", leaseGen: 0 });
  expect(projectLendCentralClaim(db, w.binding, await w.view())).toBe(true);
  expect(getLendOrder(db, w.orderId)).toMatchObject({ status: "claimed", worker: WORKER.agentId, leaseGen: 1 });
  // The claimed generation is what renew and result carry; any other one is refused before a request leaves.
  await w.client().beat(w.beat(1), "beat-1");
  await expect(w.client().beat(w.beat(2), "beat-2")).rejects.toThrow("stale_lease_gen");
  await expect(w.client().result({ ...w.verdict, gen: 2 }, { summary: "s", artifactIds: [] })).rejects.toThrow("stale_lease_gen");
  expect((await w.client().result(w.verdict, { summary: "s", artifactIds: [] })).status).toBe("confirmed");
  expect(w.order()).toMatchObject({ status: "done", leaseGen: 1 });
  expect([w.sent("lend.claim"), w.sent("lend.renew"), w.sent("lend.result")]).toEqual([1, 1, 1]);
});

test("[验收线 1] 领取回包丢失:凭回执恢复,同一个 operation,不第二次领", async () => {
  const w = await world("review", H);
  w.center.inject({ kind: "drop", command: "lend.claim" });
  expect((await w.client().claim(w.claimWire)).status).toBe("outbox");
  expect(w.order()).toMatchObject({ status: "claimed", leaseGen: 1 }); // committed; only the response was lost
  const requestId = journaledId(w);
  expect([...w.center.rows().receipts.values()].filter(r => r.command === "lend.claim").map(r => r.requestId)).toEqual([requestId]);
  for (const again of [() => w.client().recover("claim"), () => w.client().claim(w.claimWire), () => w.client().recover("claim", true)]) {
    const outcome = await again();
    expect(outcome).toMatchObject({ status: "confirmed", freshClaim: false });
    expect(outcome.status === "confirmed" && outcome.receipt.requestId).toBe(requestId);
  }
  expect([w.sent("lend.claim"), w.sent("lend.claim", "dropped")]).toEqual([1, 1]);
  expect(w.order()).toMatchObject({ status: "claimed", leaseGen: 1 });
  await w.client().beat(w.beat(1), "beat-1");
});

test("[验收线 1] 领取没到中心(503):显式恢复重放同一条命令,仍只领到第 1 代", async () => {
  const w = await world("review", H);
  w.center.inject({ kind: "unavailable", command: "lend.claim" });
  expect((await w.client().claim(w.claimWire)).status).toBe("outbox");
  expect(w.order()).toMatchObject({ status: "pooled", leaseGen: 0 });
  const journaled = lendCommandOf(w.dir, journaledId(w))!;
  expect(journaled.type === "lend.claim" && journaled.payload.claim.leaseGen).toBe(1);
  expect((await w.client().recover("claim")).status).toBe("ready"); // reconcile only: nothing is sent without an explicit resubmit
  expect(w.sent("lend.claim", 200)).toBe(0);
  expect(await w.client().recover("claim", true)).toMatchObject({ status: "confirmed", freshClaim: false });
  expect(await w.client().recover("claim", true)).toMatchObject({ status: "confirmed", freshClaim: false });
  expect(w.sent("lend.claim", 200)).toBe(1);
  expect(w.order()).toMatchObject({ status: "claimed", leaseGen: 1 });
  expect([...w.center.rows().receipts.values()].filter(r => r.command === "lend.claim").map(r => r.requestId)).toEqual([journaled.requestId]);
});
/** The requestId of the one claim this world's client journaled. */
function journaledId(w: World): string {
  const o = w.binding.order;
  return `lend-claim:${v2ObjectDigest([o.teamId, o.projectId, o.orderId, o.serviceGeneration, o.epoch, o.bootId, o.leaseGen,
    w.binding.worker, w.binding.actor.personId, w.binding.actor.serviceId])}`;
}

test("[验收线 2] 新 build 的 task.head=null、write 单带完整基线 head:claim、renew、未交付结果预检都通过", async () => {
  const w = await world("write", null);
  expect(w.center.rows().tasks.get(w.taskId)).toMatchObject({ stage: "build", head: null });
  expect(w.order().head).toBe(H);
  expect(await w.client().claim(w.claimWire)).toMatchObject({ status: "confirmed", freshClaim: true });
  expect(w.order()).toMatchObject({ status: "claimed", leaseGen: 1 });
  await w.client().beat(w.beat(1), "beat-1");
  expect(await w.client().preflight(w.deliver)).toBeNull();
  await w.client().live();
  expect([w.sent("lend.claim", 200), w.sent("lend.renew", 200), w.sent("lend.result")]).toEqual([1, 1, 0]);
});

test("[验收线 2] 例外只给 write 且 task.head=null:fix / review 的空 head、非空不符 head 都拒,零 claim", async () => {
  for (const [step, taskHead] of [["fix", null], ["review", null], ["write", OTHER], ["fix", OTHER], ["review", OTHER]] as const) {
    const w = await world(step, taskHead);
    await expect(w.client().claim(w.claimWire)).rejects.toThrow("stale_order");
    expect([step, taskHead, w.sent("lend.claim")]).toEqual([step, taskHead, 0]);
    expect(w.order()).toMatchObject({ status: "pooled", leaseGen: 0 });
  }
  // The same head binding holds after a claim: a task head that moves away from the order head stops renew and preflight.
  for (const step of ["write", "fix"] as const) {
    const w = await world(step, step === "write" ? null : H);
    expect((await w.client().claim(w.claimWire)).status).toBe("confirmed");
    w.center.seed({ tasks: [{ ...w.center.rows().tasks.get(w.taskId)!, head: step === "fix" ? null : OTHER }] });
    await expect(w.client().beat(w.beat(1), "beat-1")).rejects.toThrow("stale_order");
    await expect(w.client().preflight(w.deliver)).rejects.toThrow("stale_order");
    expect([w.sent("lend.renew"), w.sent("lend.result")]).toEqual([0, 0]);
  }
});

test("[验收线 2] 版本 / fence / grant / worker 仍严格匹配", async () => {
  const cases: [string, (w: World) => void][] = [
    ["stale_order", w => { w.binding.order.specRev = 2; }],
    ["stale_order", w => { w.binding.order.round = 1; }],
    ["stale_order", w => { w.binding.order.grantId = "grant-other"; }],
    ["stale_order", w => { w.binding.order.grantDigest = "e".repeat(64); }],
    ["stale_order", w => { w.binding.order.leaseGen = 1; }],
    ["stale_epoch", w => { w.binding.order.epoch = 2; }],
    ["forbidden", w => { w.binding.executorInstanceId = "peer-a"; w.binding.worker = RIVAL; }],
  ];
  for (const [code, mutate] of cases) {
    const w = await world("write", null);
    mutate(w);
    let caught = "";
    try { await w.client().claim({ ...w.claimWire, worker: (w.binding.worker as typeof WORKER).agentId }); } catch (e) { caught = (e as { code?: string }).code ?? String(e); }
    expect([code, caught, w.sent("lend.claim")]).toEqual([code, code, 0]);
    expect(w.order()).toMatchObject({ status: "pooled", leaseGen: 0 });
  }
});

test("[验收线 3] 取消 / 版本漂移 / 授权撤销之后:零 claim", async () => {
  for (const [code, change] of [["stale_order", "cancel"], ["stale_order", "drift"], ["authorization_expired", "revoke"]] as const) {
    const w = await world("write", null);
    w[change]();
    const before = w.center.rows();
    await expect(w.client().claim(w.claimWire)).rejects.toThrow(code);
    expect([change, w.sent("lend.claim")]).toEqual([change, 0]);
    expect([before.orders, before.lendLeases]).toEqual([w.center.rows().orders, w.center.rows().lendLeases]);
  }
});

test("[验收线 3] 并发:本机读完视图后才取消 / 漂移 / 撤销,领取仍没落成", async () => {
  for (const change of ["cancel", "drift", "revoke"] as const) {
    const w = await world("write", null);
    w.race(() => w[change]()); // lands between the client's online view read and its command
    await expect(w.client().claim(w.claimWire)).rejects.toThrow(change === "revoke" ? "authorization_expired" : "stale_order");
    expect([change, w.sent("lend.claim", 200)]).toEqual([change, 0]);
    expect(w.order().status).toBe(change === "cancel" ? "cancelled" : "pooled");
    expect([w.order().leaseGen, w.center.rows().lendLeases.size]).toEqual([0, 0]);
  }
});

test("[验收线 3] 已领后取消 / 漂移 / 撤销:预检或发布前复核就停,零 publish、零 result;正常顺序 preflight→publish→result 原样通过", async () => {
  for (const [code, change] of [["stale_order", "cancel"], ["stale_order", "drift"], ["authorization_expired", "revoke"]] as const) {
    for (const when of ["before preflight", "after preflight"] as const) {
      const w = await world("write", null), log: string[] = [];
      expect((await w.client().claim(w.claimWire)).status).toBe("confirmed");
      if (when === "before preflight") w[change]();
      else { let reads = 0; const arm = () => w.race(() => { if (++reads === 2) w[change](); else arm(); }); arm(); } // after live()'s own view read
      if (when === "after preflight") {
        // preflight passes, the change lands while the publish port's check is in flight: the next check stops the effect.
        const client = w.client();
        expect(await client.preflight(w.deliver)).toBeNull();
        await client.live().catch(() => {});
        await expect(client.live()).rejects.toThrow(code);
      } else await expect(deliverFlow(w, log)).rejects.toThrow(code);
      expect([change, when, log.includes("publish"), w.sent("lend.result")]).toEqual([change, when, false, 0]);
    }
  }
  const w = await world("write", null), log: string[] = [];
  expect((await w.client().claim(w.claimWire)).status).toBe("confirmed");
  expect((await deliverFlow(w, log)).status).toBe("confirmed");
  expect(log).toEqual(["preflight", "publish", "result"]);
  expect(w.order()).toMatchObject({ status: "done", leaseGen: 1 });
  expect(w.sent("lend.result", 200)).toBe(1);
});

test("[验收线 5] step.assign 已指派另一个 executor 之后,迟到的旧 pooled claim 被拒,订单 / lease / step 零写", async () => {
  const w = await world("write", null);
  // The claim was built while the order was pooled and never reached the center.
  w.center.inject({ kind: "unavailable", command: "lend.claim" });
  expect((await w.client().claim(w.claimWire)).status).toBe("outbox");
  expect(w.k.post(ACTORS.owner, w.k.command("step.assign", { ...w.versions, step: "write", round: 0, executor: RIVAL })).status).toBe(200);
  const before = w.center.rows();
  expect(before.steps).toHaveLength(1);
  // It arrives late: the order is still pooled at generation 0, so the client's own checks pass and the center decides.
  await expect(w.client().recover("claim", true)).rejects.toThrow("stale_order");
  await expect(w.client().claim(w.claimWire)).resolves.toMatchObject({ status: "ready" }); // never a fresh second claim
  const after = w.center.rows();
  expect(w.sent("lend.claim", 200)).toBe(0);
  expect([after.orders, after.lendLeases, after.steps]).toEqual([before.orders, before.lendLeases, before.steps]);
  expect(after.orders.get(w.orderId)).toMatchObject({ status: "pooled", leaseGen: 0, worker: null });
  expect(after.steps[0]).toMatchObject({ executor: RIVAL, state: "assigned" });
  await expect(w.client().beat(w.beat(1), "beat-1")).rejects.toThrow("stale_order");
});
