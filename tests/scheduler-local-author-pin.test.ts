/** LOCAL1: explicit local placement / localAuthorOnly in the unified pool, and the slot a ticketed manual author holds. */
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { placeFor, type PeerFacts, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { explicitLocal, pinnedPeer, placementPin } from "../src/lib/scheduler-local-pin.js";
import { localAgentPool } from "../src/lib/scheduler-agent-pool-ledger.js";
import { manualAuthorTicket } from "../src/lib/scheduler-manual-author.js";
import { specPlaceBlock } from "../src/lib/scheduler-spec-resume-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask } from "../src/lib/ledger-store.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const peer = (name: string, slots = { claude: 1, codex: 1 }): PeerFacts => ({
  peer: name, roles: [], priority: "off", open: 99,
  v2: { why: null, roles: [], repos: ["o/r"], slots, familyTotals: { claude: 5, codex: 5 }, familyBusy: { claude: 0, codex: 0 } },
});
const facts = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  remote: { mode: "balance", roles: [], poolTimeoutMin: 15, agents: { claude: 1, codex: 1 } },
  peers: [peer("mate")], local: { room: true, running: 0, pool: { totals: { claude: 1, codex: 1 }, running: { claude: 0, codex: 0 } } },
  repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true, ...over,
});

test("pins: local / localAuthorOnly are this machine, never a peer named \"\"; only peer:<name> names a peer", () => {
  expect(explicitLocal({ placement: "local" })).toBe(true);
  expect(explicitLocal({ localAuthorOnly: true })).toBe(true);
  expect(explicitLocal({ localAuthorOnly: "true", placement: "anything" })).toBe(false);
  expect(pinnedPeer("local")).toBeNull();
  expect(pinnedPeer("peer:")).toBeNull();
  expect(pinnedPeer("peer:mate")).toBe("mate");
  expect(placementPin({ localAuthorOnly: true, placement: "peer:mate" })).toBe("local");
  expect(placementPin({ placement: "elsewhere" })).toBeNull();
});

test("pool: a local pin writes here or waits here; review stays cross-family and may go remote; default / peer pins unchanged", () => {
  for (const role of ["write", "fix"] as const) {
    expect(placeFor(facts({ pin: "local" }), role, "claude")).toMatchObject({ kind: "local", family: "claude" });
    const full = facts({ pin: "local" }); full.local.pool!.running = { claude: 1, codex: 1 };
    expect(placeFor(full, role, "claude")).toEqual({ kind: "wait", reason: expect.stringContaining("固定本机") });
  }
  // Before the fix "local".slice(5) was "" (no pin) and the tie went to the peer.
  expect(placeFor(facts(), "write", "claude")).toMatchObject({ kind: "peer", peer: "mate" });
  expect(placeFor(facts({ pin: "peer:mate" }), "write", "claude")).toMatchObject({ kind: "peer", peer: "mate" });
  expect(placeFor(facts({ pin: "local" }), "review", "codex")).toMatchObject({ kind: "peer", peer: "mate", family: "codex" });
});

const remote: RemotePolicy = { agents: { claude: 5, codex: 5 }, mode: "balance", roles: [], poolTimeoutMin: 15, repo: "o/r" };
const borrow = [{ peer: "mate", projects: ["p"], maxOpen: 5, roles: ["review", "write"] as ("review" | "write")[] }];
function hello(f: ReturnType<typeof autoFixture>, repos = ["o/r"], seq = 1) {
  recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "b", seq, paused: null,
    slots: { claude: { total: 5, busy: 0 }, codex: { total: 5, busy: 0 } },
    grant: { until: 100000, repos, roles: ["review", "write"], ordersPerDay: 50, ordersLeftToday: 50 } }, 1000);
}
const snap = (f: ReturnType<typeof autoFixture>) => autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 5, now: 1000, pool: { remote, borrow } });

test("planner: localAuthorOnly build dispatches to the local author, a lease never moves it out; review still crosses to the peer", async () => {
  const f = autoFixture();
  try {
    await f.tick();
    f.db.query("UPDATE scheduler_intents SET status='done'").run();
    hello(f);
    f.db.query("UPDATE tasks SET stage='build' WHERE id='T1'").run();
    expect(planScheduler(snap(f))).toMatchObject({ kind: "intent", action: "dispatch", recipient: "peer:mate" }); // default unchanged
    f.db.query("UPDATE tasks SET extra=json_set(extra,'$.localAuthorOnly',json('true')) WHERE id='T1'").run();
    expect(planScheduler(snap(f))).toMatchObject({ kind: "intent", action: "dispatch", recipient: "agent-task-one" });
    const leased = snap(f); leased.pool!.writeLeasePeer = "mate";
    expect(planScheduler(leased)).toMatchObject({ kind: "wait", reason: expect.stringContaining("不外派") });
    f.db.query("UPDATE tasks SET stage='review', headSHA=?, pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H1);
    expect(planScheduler(snap(f))).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    // Grant revoked (scope / authorization): the review waits instead of using the peer; the local card's writing never needed it.
    hello(f, ["other/repo"], 2);
    expect(planScheduler(snap(f))).not.toMatchObject({ recipient: "peer:mate" });
  } finally { f.close(); }
});

test("slot: an unbound manual author holds one seat on a manager ticket; unrelated manual agents and extra fields hold none", () => {
  const f = autoFixture();
  try {
    const seats = () => localAgentPool(f.db, "p", { claude: 5, codex: 5 }).running;
    expect(seats()).toEqual({ claude: 0, codex: 0 });
    f.db.query("UPDATE tasks SET extra=json_set(extra,'$.manualAuthor',json('true'),'$.slot','agent-task-one') WHERE id='T1'").run();
    createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "idle manual", kind: "code", agent: "agent-idle" });
    expect(seats()).toEqual({ claude: 0, codex: 0 });
    assignStep(f.db, f.at("owner"), { taskId: "T1", step: "write", executor: "agent-other", executorKind: "agent" });
    expect(manualAuthorTicket(f.db, f.task())).toBe(false);
    assignStep(f.db, f.at("owner"), { taskId: "T1", step: "write", executor: "agent-task-one", executorKind: "agent" });
    expect(manualAuthorTicket(f.db, f.task())).toBe(true);
    expect(seats()).toEqual({ claude: 1, codex: 0 });
    expect(localAgentPool(f.db, "p", { claude: 5, codex: 5 }, "T1").running.claude).toBe(0); // the card itself is excluded
    f.db.run("PRAGMA foreign_keys=OFF");
    f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('T1', 'author', 'agent-task-one', 's-one', 'claude', 'tmux', 'active', 'i', 0, 0)`).run();
    expect(seats()).toEqual({ claude: 1, codex: 0 }); // bound later: still exactly one
  } finally { f.close(); }
});

test("back to auto: spec placement never re-places a localAuthorOnly card or one a manual author is working", () => {
  const f = autoFixture();
  try {
    const block = () => specPlaceBlock(f.db, getTask(f.db, "T1")!, getWorkflow(f.db, "T1"));
    expect(block()).toBeNull();
    assignStep(f.db, f.at("owner"), { taskId: "T1", step: "write", executor: "agent-task-one", executorKind: "agent" });
    expect(block()).toContain("手动作者");
    f.db.query("UPDATE tasks SET extra=json_set(extra,'$.localAuthorOnly',json('true')) WHERE id='T1'").run();
    expect(block()).toContain("固定本机");
  } finally { f.close(); }
});


test("reconcile-capacity: full / quota-zero planner reaches author reconciliation, but keeps dispatch gates", async () => {
  for (const total of [1, 0]) {
    const f = autoFixture();
    try {
      createTask(f.db, f.at("owner"), { project: "p", id: "T9", title: "busy", kind: "code", agent: "agent-busy" });
      setWorkflow(f.db, f.at("owner"), { taskId: "T9", taskRev: 1, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude", fallback: "report" });
      assignStep(f.db, f.at("owner"), { taskId: "T9", step: "write", executor: "agent-busy", executorKind: "agent" });
      await f.cli("owner", "task-set", "T1", "--rev", String(f.task().rev), "--branch", "lend/t1", "--extra", '{"fileGlobs":["src/lib/x.ts"],"localAuthorOnly":true}');
      const registry = JSON.parse(readFileSync(f.registryPath, "utf8"));
      Object.assign(registry.agents["agent-task-one"], { projectId: "p", task: "T1", status: "active" });
      writeFileSync(f.registryPath, JSON.stringify(registry));
      const remoteFull = { ...remote, agents: { claude: total, codex: 1 } };
      const snapshot = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 1, now: 1000,
        pool: { remote: remoteFull, borrow: [] } });
      for (const stage of ["spec", "build"] as const) {
        expect(planScheduler({ ...snapshot, task: { ...snapshot.task, stage } })).toMatchObject({ kind: "intent", action: "ensure_session" });
      }
      const leased = { ...snapshot, task: { ...snapshot.task, stage: "build" as const }, pool: { ...snapshot.pool!, writeLeasePeer: "mate" } };
      expect(planScheduler(leased)).toMatchObject({ kind: "wait", reason: expect.stringContaining("不外派") });
      let creates = 0;
      const real = autoTickDeps(f.db, { registryPath: f.registryPath, git: async () => ({ code: 0, out: "lend/t1" }),
        create: async () => { creates++; return { ok: false }; } });
      const result = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 1, remote: remoteFull } },
        { ...f.tickDeps, ensure: real.ensure, borrow: async () => [] });
      expect(result.failed).toEqual([]);
      expect(result.cards[0]).toMatchObject({ step: "session" });
      expect(f.intents()).toMatchObject([{ action: "ensure_session", status: "done" }]);
      expect(creates).toBe(0);
      const bound = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 1, now: 1000,
        pool: { remote: remoteFull, borrow: [] } });
      expect(planScheduler(bound)).toMatchObject({ kind: "wait" });
    } finally { f.close(); }
  }
});

test("manual-double-seat: submitted, unknown and bound author each reserve exactly one seat", async () => {
  const f = autoFixture();
  try {
    assignStep(f.db, f.at("owner"), { taskId: "T1", step: "write", executor: "agent-task-one", executorKind: "agent" });
    const seats = () => localAgentPool(f.db, "p", { claude: 5, codex: 5 }).running.claude;
    expect(seats()).toBe(1);
    let submitted = 0;
    const original = f.tickDeps.ensure;
    f.tickDeps.ensure = async () => {
      submitted = seats();
      return { kind: "unknown", reason: "existing author identity unreadable" };
    };
    expect(await f.tick()).toMatchObject({ step: "held" });
    expect(submitted).toBe(1);
    expect(seats()).toBe(1);
    const intent = f.intents()[0];
    expect(await f.cli("owner", "scheduler-settle", intent.id, "--from", "unknown", "--to", "cancelled", "--receipt", "owner verified no creation")).toMatchObject({ ok: true });
    f.tickDeps.ensure = original;
    expect(await f.tick()).toMatchObject({ step: "session" });
    expect(seats()).toBe(1);
  } finally { f.close(); }
});
