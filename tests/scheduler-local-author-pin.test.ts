/** LOCAL1: explicit local placement / localAuthorOnly in the unified pool, and the slot a ticketed manual author holds. */
import { expect, test } from "bun:test";
import { placeFor, type PeerFacts, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { explicitLocal, pinnedPeer, placementPin } from "../src/lib/scheduler-local-pin.js";
import { localAgentPool } from "../src/lib/scheduler-agent-pool-ledger.js";
import { manualAuthorTicket } from "../src/lib/scheduler-manual-author.js";
import { specPlaceBlock } from "../src/lib/scheduler-spec-resume-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask } from "../src/lib/ledger-write.js";
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
