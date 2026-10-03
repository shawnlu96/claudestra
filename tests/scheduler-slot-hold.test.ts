import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getFeature, type Feature } from "../src/lib/ledger-feature.js";
import { releaseFinishedCardLeases } from "../src/lib/ledger-scheduler-lease.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import type { Stage } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, deliver, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { featureGate, type ServiceFacts } from "../src/lib/scheduler-autostart.js";
import { HELLO_FRESH_MS } from "../src/lib/lend-wire-v2.js";
import { planScheduler, type PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { poolFacts } from "../src/lib/scheduler-pool-facts.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { availableWriteSlot, shouldHoldWriteSlot } from "../src/lib/scheduler-slot-hold.js";
import { writeSlotFacts } from "../src/lib/scheduler-slot-hold-facts.js";
import type { SlotPool } from "../src/lib/scheduler-slot-hold-autostart.js";

const NOW = 10_000_000, HEAD = "a".repeat(40), ctx = { actor: "owner", now: NOW };
const pool: SlotPool = { remote: { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 },
  borrow: [{ peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 5 }] };
let db: Database, feature: Feature, svc: ServiceFacts;

beforeEach(() => {
  db = openLedger(":memory:");
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  const f = createFeature(db, ctx, { project: "p", slug: "slots", title: "slots" }).row;
  initDag(db, ctx, { id: f.id, rev: f.rev, nodes: [{ key: "next", oneLine: "next", fileGlobs: ["next.ts"], deps: [] }] });
  feature = getFeature(db, f.id)!;
  svc = { autoDispatch: true, projects: ["p"], maxWorkers: () => 2, pool: () => ({ remote: null, borrow: [] }), now: () => NOW };
});
afterEach(() => closeLedger(":memory:"));

function card(id: string, stage: Stage = "build"): void {
  createTask(db, ctx, { project: "p", id, title: id, kind: "code", agent: `agent-${id}`, extra: { fileGlobs: [`src/${id}.ts`] } });
  setWorkflow(db, ctx, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  db.run("UPDATE tasks SET stage = ?, round = 0, headSHA = ? WHERE id = ?", [stage, HEAD, id]);
}

function snapshot(id: string): PlannerSnapshot {
  const base = observeSnapshot(db, getTask(db, id)!, { registry: [], maxWorkers: 2, now: NOW });
  return { ...base, author: { agent: `agent-${id}`, sessionId: `s-${id}`, taskId: id, family: "claude", source: "local" } };
}

function dispatch(id: string, complete = true) {
  const s = snapshot(id), p = planScheduler(s);
  expect(p).toMatchObject({ kind: "intent", action: "dispatch" });
  if (p.kind !== "intent") throw new Error(JSON.stringify(p));
  const seq = (db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
  const result = planIntent(db, { actor: "scheduler", now: NOW }, { id: p.id, taskId: id, taskRev: s.task.rev, workflowRev: s.workflow!.rev,
    causalSeq: seq, node: p.node, action: p.action, reason: p.reason, recipient: p.recipient!, resources: p.resources });
  if (complete) {
    settleIntent(db, ctx, { id: p.id, from: "pending", to: "submitted" });
    settleIntent(db, ctx, { id: p.id, from: "submitted", to: "done" });
  }
  return result.intent;
}

const resources = (id: string) => db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? ORDER BY resource").all(id);
const review = (id: string) => deliver(db, ctx, { taskId: id, headSHA: HEAD, moveFrom: "build" });

function repair(id: string, from: "review" | "merge" | "live" = "review"): void {
  card(id);
  review(id);
  insertEvent(db, ctx, { project: "p", target: id, kind: "review", data: { round: 1, head: HEAD, verdict: "changes", p0: 0, p1: 1, p2: 0,
    reviewer: "reviewer", reviewerSessionId: "rv", reviewerFamily: "codex", path: "review.md",
    findings: [{ findingId: "race", family: "race", severity: "P1", basis: "acceptance:1", probe: "concurrent writes" }] } }, false);
  if (from !== "review") db.run("UPDATE tasks SET stage = ? WHERE id = ?", [from, id]);
  moveStage(db, ctx, { taskId: id, from, to: "fix" });
  if (from === "merge") {
    insertEvent(db, ctx, { project: "p", target: id, kind: "stage", data: { from, to: "fix", round: 1, specRev: 1,
      mergeBounce: { cause: "ci_fail", prHead: HEAD, mainHead: null, checks: [{ name: "check", link: "https://github.com/o/r/actions/runs/1" }] } } }, false);
  }
}

function peerOrder(id: string, step = "write", status = "claimed"): void {
  db.run(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,leaseMs,createdBy,createdAt,updatedAt)
    VALUES (?,?,'p','mate','codex',?,1,1,?,'o/r','{}','x','sha',?,60000,'scheduler',1,1)`, [`lend-${id}`, id, step, HEAD, status]);
}

function hello(at = NOW, claudeSlots = 0): void {
  recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
    slots: { codex: { total: 5, busy: 0 }, claude: { total: claudeSlots, busy: 0 } },
    grant: { until: NOW + 3_600_000, roles: ["write"], repos: ["o/r"], ordersPerDay: 20, ordersLeftToday: 20 } }, at);
}

describe("local write slots", () => {
  test("two cards entering review free both slots and a third ready card can actually claim local writing", () => {
    for (const id of ["one", "two"]) { card(id); dispatch(id); }
    card("three");
    expect(planScheduler(snapshot("three"))).toMatchObject({ kind: "wait", code: "capacity" });
    for (const id of ["one", "two"]) {
      review(id);
      expect(resources(id)).toEqual([{ resource: `src/${id}.ts` }]);
    }
    expect(snapshot("three").workerCount).toBe(0);
    expect(dispatch("three").recipient).toBe("agent-three");
    expect(snapshot("three").workerCount).toBe(1);
  });

  test("pending and unknown local claims count until review; stage evidence frees only the worker slot", () => {
    card("one");
    const intent = dispatch("one", false);
    expect(snapshot("one").workerCount).toBe(1);
    settleIntent(db, ctx, { id: intent.id, from: "pending", to: "unknown" });
    expect(snapshot("one").workerCount).toBe(1);
    review("one");
    expect(resources("one")).toContainEqual({ resource: "src/one.ts" });
    expect(resources("one").some((r) => (r as { resource: string }).resource.startsWith("slot:"))).toBe(false);
  });

  test("stale pre-upgrade review slot is ignored by snapshots and reclaimed in the acquisition transaction", () => {
    card("old");
    dispatch("old");
    db.run("UPDATE tasks SET stage = 'review' WHERE id = 'old'");
    card("fresh");
    expect(resources("old")).toContainEqual({ resource: "slot:p:0" });
    expect(snapshot("fresh")).toMatchObject({ workerCount: 0, freeWorkerSlot: "slot:p:0" });
    dispatch("fresh");
    expect(resources("old")).toEqual([{ resource: "src/old.ts" }]);
    expect(resources("fresh")).toContainEqual({ resource: "slot:p:0" });
  });

  test("merge frees slots; live settles orphaned writes and frees their file locks", () => {
    card("one");
    const i = dispatch("one", false);
    db.run("UPDATE tasks SET stage = 'merge' WHERE id = 'one'");
    releaseFinishedCardLeases(db, "one");
    expect(snapshot("one").workerCount).toBe(0);
    expect(resources("one")).toContainEqual({ resource: "src/one.ts" });
    moveStage(db, ctx, { taskId: "one", from: "merge", to: "live" });
    expect(db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(i.id)).toEqual({ status: "cancelled" });
    expect(resources("one")).toEqual([]);
  });

  for (const from of ["review", "merge"] as const) {
    test(`${from} return gets exactly one overflow slot at maxWorkers=2; neither a new card nor a second repair can exceed it`, () => {
      for (const id of ["one", "two"]) { card(id); dispatch(id); }
      repair("fix", from);
      card("fresh");
      expect(planScheduler(snapshot("fresh"))).toMatchObject({ kind: "wait", code: "capacity" });
      dispatch("fix");
      expect(resources("fix")).toContainEqual({ resource: "slot:p:2" });
      repair("later", from);
      expect(planScheduler(snapshot("later"))).toMatchObject({ kind: "wait", code: "capacity" });
      expect(snapshot("fix").workerCount).toBe(3);
      // Replay of an already claimed repair keeps its own slot even when capacity is now max+1.
      const s = snapshot("fix");
      expect(planScheduler({ ...s, intents: [] })).toMatchObject({ kind: "intent", resources: expect.arrayContaining(["slot:p:2"]) });
    });
  }

  test("an unclaimed local repair gets the normal vacancy ahead of a new card, including autostart", () => {
    card("one"); dispatch("one");
    repair("fix"); card("fresh");
    expect(featureGate(db, feature, svc)?.why).toContain("优先");
    expect(planScheduler(snapshot("fresh"))).toMatchObject({ kind: "wait", code: "capacity" });
    dispatch("fix");
    expect(resources("fix")).toContainEqual({ resource: "slot:p:1" });
  });

  test("a live rollback fix cannot borrow the extra slot", () => {
    for (const id of ["one", "two"]) { card(id); dispatch(id); }
    repair("rollback", "live");
    expect(availableWriteSlot(snapshot("rollback"))).toBeNull();
  });

  test("a repair with a peer write lease stays remote without a local slot or priority reservation", () => {
    repair("fix");
    holdWriteLease(db, getTask(db, "fix")!, { peer: "mate", fp: "aaaa-bbbb-cccc-dddd", branch: "lend/fix-aaaa", repo: "o/r" }, NOW);
    // A fix stays in the original Claude author family; Codex-only capacity cannot resume this writer.
    hello(NOW, 1);
    const s = snapshot("fix");
    s.pool = poolFacts(db, s.task, { remote: pool.remote!, borrow: pool.borrow, now: NOW });
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "dispatch", recipient: "peer:mate" });
    const plan = planScheduler(s);
    if (plan.kind === "intent") expect(plan.resources.some((r) => r.startsWith("slot:"))).toBe(false);
    expect(writeSlotFacts(db, "p")).toMatchObject({ workerCount: 0, waitingFix: false });
    expect(featureGate(db, feature, svc)).toBeNull();
  });
});

describe("autostart across three machines", () => {
  test("two claimed peer writes plus an auto merge card do not exhaust local maxWorkers=2", () => {
    for (const id of ["peer1", "peer2"]) { card(id); dispatch(id); peerOrder(id); }
    card("merging", "merge");
    expect(featureGate(db, feature, svc)).toBeNull();
    expect(writeSlotFacts(db, "p").workerCount).toBe(0);
  });

  test("a fresh authorized peer lets new cards open when the local writing slots are full", () => {
    for (const id of ["one", "two"]) { card(id); dispatch(id); }
    expect(featureGate(db, feature, svc)?.gate).toBe("capacity");
    hello(); svc.pool = () => pool;
    expect(featureGate(db, feature, svc)).toBeNull();
    svc.now = () => NOW + HELLO_FRESH_MS + 1;
    expect(featureGate(db, feature, svc)?.gate).toBe("capacity");
  });

  for (const change of ["no-write", "full", "revoked", "borrow-full", "off", "wrong-repo"] as const) {
    test(`a ${change} peer cannot provide autostart capacity`, () => {
      for (const id of ["one", "two"]) { card(id); dispatch(id); }
      hello(); svc.pool = () => pool;
      if (change === "no-write") db.run("UPDATE lend_peers SET grant = json_set(grant, '$.roles', json('[\"review\"]'))");
      if (change === "full") db.run("UPDATE lend_peers SET slots = json_set(slots, '$.codex.busy', 5)");
      if (change === "revoked") db.run("UPDATE lend_peers SET grant = NULL");
      if (change === "borrow-full") svc.pool = () => ({ ...pool, borrow: [{ ...pool.borrow[0], maxOpen: 0 }] });
      if (change === "off") svc.pool = () => ({ ...pool, remote: { ...pool.remote!, mode: "off" } });
      if (change === "wrong-repo") svc.pool = () => ({ ...pool, remote: { ...pool.remote!, repo: "other/repo" } });
      expect(featureGate(db, feature, svc)?.gate).toBe("capacity");
    });
  }

  test("six in-flight auto cards stop autostart with the maxActiveWorkers × 3 reason even with peer room", () => {
    for (let i = 0; i < 5; i++) card(`card${i}`, "review");
    hello(); svc.pool = () => pool;
    expect(featureGate(db, feature, svc)).toBeNull();
    card("six", "merge");
    expect(featureGate(db, feature, svc)).toMatchObject({ gate: "capacity", why: expect.stringContaining("maxActiveWorkers × 3（6，三台机器）") });
    moveStage(db, ctx, { taskId: "six", from: "merge", to: "live" });
    expect(featureGate(db, feature, svc)).toBeNull();
  });

  test("start_node includes the local candidate after two cards enter review", async () => {
    for (const id of ["one", "two"]) { card(id); dispatch(id); }
    hello();
    const io = { policy: () => ({ remote: { ...pool.remote!, localPriority: "first" as const }, maxWorkers: 2 }),
      borrow: async () => pool.borrow, originRepo: async () => "o/r", now: () => NOW };
    const q = { project: "p", repoDir: "/r", fileGlobs: ["fresh.ts"], want: "auto" as const };
    expect(await startPlacement(db, io, q)).toMatchObject({ where: "peer" });
    for (const id of ["one", "two"]) review(id);
    expect(await startPlacement(db, io, q)).toMatchObject({ where: "local" });
  });
});

test("pure hold policy distinguishes stage, live write/fix orders, and review-only orders", () => {
  for (const stage of ["spec", "restate", "build", "fix"]) {
    const f = { stage, writeLease: null, orders: [] };
    expect(shouldHoldWriteSlot(f)).toBe(true);
    expect(shouldHoldWriteSlot({ ...f, writeLease: { state: "held" } })).toBe(false);
    for (const step of ["write", "fix"]) for (const status of ["pooled", "claimed", "unknown"]) {
      expect(shouldHoldWriteSlot({ ...f, orders: [{ step, status }] })).toBe(false);
    }
    expect(shouldHoldWriteSlot({ ...f, orders: [{ step: "review", status: "claimed" }, { step: "write", status: "done" }] })).toBe(true);
  }
  for (const stage of ["review", "merge", "live", "verified", "done", "cancelled", "blocked"]) {
    expect(shouldHoldWriteSlot({ stage, writeLease: null, orders: [] })).toBe(false);
  }
});
