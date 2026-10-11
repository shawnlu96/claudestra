/**
 * S2F acceptance 3 over the daemon's real pass entry: S2C fake center + S2T signed transport + the production lease adapter
 * (no injected leases) + `schedulerV2Pass` → real `schedulerPass` (schedulerAutoTick, mergeTick) with fake worker / ensure ports.
 * A member's `task.new` and the owner's `workflow.set auto` land through the pre-pass projection only.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { commands, F, intentsOf, memberCards, until, resetWorld, world } from "./shared-ledger-v2-stage2-wiring-world.test.js";

beforeEach(resetWorld);
afterEach(resetWorld);

test("acceptance 3 · pass 1: the pre-pass lands a member's center-only card, S2Q runs ensure → bind → done with 0 center commands", async () => {
  const s = await world();
  const { T, C } = await memberCards(s);
  // The production lease adapter (no injected leases) acquires through the signed transport.
  await until(() => s.w.leases.current(F) !== null);
  expect(commands(s.requests)).toContain("lease.acquire");
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  // Projection reads only; the new card's lease is added under the same term; no intent / result command.
  expect(commands(s.requests.slice(before)).filter((c) => c !== "lease.acquire")).toEqual([]);
  expect(getTask(s.db, T)).toMatchObject({ featureId: F, stage: "spec" });
  expect(s.ensured).toEqual([`${T}:author`]);
  expect(intentsOf(s.db, T)).toEqual([{ id: expect.any(String), action: "ensure_session", status: "done" }]);
  expect(s.db.query("SELECT agent, state FROM scheduler_sessions WHERE taskId = ?").all(T)).toEqual([{ agent: "w-author", state: "active" }]);
  // Every scheduler event of the card was written under S2G's executor token (fence with leaseId), none outside it.
  const events = s.db.query("SELECT data FROM events WHERE target = ? AND kind = 'scheduler'").all(T) as { data: string }[];
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) expect(JSON.parse(e.data).fence).toMatchObject({ bootId: s.w.leases.current(F)!.bootId, leaseId: expect.any(String) });
  expect(s.real).toHaveLength(0);
  expect(intentsOf(s.db, C)).toEqual([]);
});

test("acceptance 3 · pass 2: dispatch becomes a center intent through S2Q (planData) and lands back through the projection", async () => {
  const s = await world();
  const { T, C } = await memberCards(s);
  await until(() => s.w.leases.current(F) !== null);
  await s.pass();
  // Test-only fixture (PM 04:5x): the card's home-only fileGlobs, standing in for S2F3's future source; not a pass write.
  s.db.query(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["src/x.ts"]')) WHERE id = ?`).run(T);
  const before = s.requests.length;
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(commands(s.requests.slice(before))).toContain("intent.create");
  const center = [...s.k.center.rows().intents.values()].filter((i) => i.taskId === T);
  expect(center.map((i) => [i.action, i.resources])).toEqual([["dispatch",
    [{ ...V2_FIXTURE_SCOPE, repository: "team/repository", kind: "file", path: "src/x.ts" }]]]);
  // The projection keys the local row by the center's operationId = the home plan id; the ensure intent / session survive.
  expect(intentsOf(s.db, T).map((i) => [i.id, i.action])).toEqual([[expect.any(String), "ensure_session"], [center[0]!.operationId, "dispatch"]]);
  expect(s.db.query("SELECT state FROM scheduler_sessions WHERE taskId = ?").all(T)).toEqual([{ state: "active" }]);
  expect(s.real).toHaveLength(0);
  expect(intentsOf(s.db, C)).toEqual([]);
  expect([...s.k.center.rows().intents.values()].filter((i) => i.taskId === C)).toEqual([]);
});

test("planner origin: a card whose only task events are absent projections still escalates task_origin", async () => {
  const s = await world();
  const { T } = await memberCards(s);
  await until(() => s.w.leases.current(F) !== null);
  await s.pass();
  const { planScheduler } = await import("../src/lib/scheduler-plan.js");
  const { observeSnapshot } = await import("../src/lib/scheduler-snapshot.js");
  const snapshot = observeSnapshot(s.db, getTask(s.db, T)!, { registry: [], maxWorkers: 2, now: Date.now() });
  expect(planScheduler(snapshot)).not.toMatchObject({ code: "task_origin" });
  // Events are append-only: the absent-only card is the same snapshot with every task event marked absent.
  const absentOnly = { ...snapshot, events: snapshot.events.map((e) => e.kind === "task" ? { ...e, data: { ...e.data, absent: true } } : e) };
  expect(planScheduler(absentOnly)).toMatchObject({ code: "task_origin" });
});

// Acceptance 3 ends at the projected dispatch intent (PM 05:0x second section). The send, S2L result, review, merge, verified
// and retire run end to end in X13 once S2F5 (one intent.check, by X8 before the send; S2C intent ids = operationId) and S2F6
// (home cancel of its own pending intents) land; S2J / S2M / S2L are verified per port in shared-ledger-v2-stage2-wiring-ports.
