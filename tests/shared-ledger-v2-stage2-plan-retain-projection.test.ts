/**
 * S2F4 at the projection writer: retained proposals fill the recipient on insert only, land one `scheduler:<id>` plan event in
 * the same transaction, and are released / reported only after the commit. Synthetic center views (S2P fixture), real schema.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { driveDispatch, type SchedulerLedgerOps } from "../src/lib/scheduler-dispatch.js";
import type { SessionRef, WorkerSession, WorkOrder } from "../src/lib/worker-session.js";
import { PROJECTION_ACTOR, withProjectionScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import type { PlanIntentInput } from "../src/lib/ledger-scheduler-write.js";
import { clearRetainedPlans, PLAN_RETAIN_LIMIT, retainedPlan, retainedPlanCount, retainPlan, type RetainedPlan } from "../src/lib/shared-ledger-v2-plan-retain.js";
import { executionMode, HEAD_A, intent, ledger, ref, task, view, workflow, type Ledger } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

beforeEach(clearRetainedPlans);
afterEach(clearRetainedPlans);

const proposal = (id: string, taskId: string, patch: Partial<RetainedPlan> = {}) => ({ id, taskId, workflowRev: 1, node: "write", action: "dispatch",
  recipient: "w-author", reason: `home ${id}`, taskRev: 4, causalSeq: 41, resources: ["task:s1", "src/b.ts", "src/a.ts", "src/b.ts"], ...patch }) as PlanIntentInput;
const cards = [task("T1"), task("T2")], flows = ["T1", "T2"].map(id => workflow(id));
const land = (l: Ledger, seq: number, intents: Record<string, any>[], extra: Record<string, unknown> = {}) =>
  writeExecutionProjection(l.db, view(seq, { tasks: cards, workflows: flows, intents }), { ...ref, retained: retainedPlan, ...extra });
const recipient = (l: Ledger, id: string) => (l.db.query("SELECT recipient FROM scheduler_intents WHERE id = ?").get(id) as { recipient: string | null }).recipient;
const planEvents = (l: Ledger) => l.rows("SELECT target, dedupKey, data FROM events WHERE kind = 'scheduler' ORDER BY seq")
  .map(e => ({ target: e.target, dedupKey: e.dedupKey, data: JSON.parse(e.data) }));
function withLedger(run: (l: Ledger) => void | Promise<void>) {
  return async () => {
    const l = ledger();
    try { l.setMode(executionMode); await run(l); } finally { l.close(); }
  };
}

describe("S2F4 retained plan → projected intent", () => {
  test("[验收线 2] review and pool:<peer> recipients land as retained; the plan event carries the full proposal with sorted home resources", withLedger(l => {
    retainPlan(proposal("d1", "T1", { recipient: "pool:peer-a" }));
    retainPlan(proposal("r1", "T2", { node: "review", action: "review", recipient: "w-reviewer", resources: [] }));
    land(l, 10, [intent("d1", "T1"), intent("r1", "T2", { node: "review", action: "review" })]);
    expect(recipient(l, "d1")).toBe("pool:peer-a");
    expect(recipient(l, "r1")).toBe("w-reviewer");
    const events = planEvents(l);
    expect(events.map(e => [e.target, e.dedupKey, e.data.op])).toEqual([["T1", "scheduler:d1", "center-plan"], ["T2", "scheduler:r1", "center-plan"]]);
    expect(events[0]!.data.plan).toEqual({ id: "d1", taskId: "T1", workflowRev: 1, resources: ["src/a.ts", "src/b.ts", "task:s1"], node: "write",
      action: "dispatch", recipient: "pool:peer-a", reason: "home d1", taskRev: 4, causalSeq: 41 });
    // The center's own reason / causalSeq stay on the row; only the proposal knows the home's.
    expect(getIntent(l.db, "d1")).toMatchObject({ reason: "center d1", causalSeq: 3, recipient: "pool:peer-a" });
    expect(events[0]!.data).toMatchObject({ centerSeq: 10, featureId: "F" });
    expect(retainedPlanCount()).toBe(0);
  }));

  test("[验收线 1] the dispatch driver sends a projected intent whose recipient came from the retained plan; without it the driver cancels", withLedger(async l => {
    retainPlan(proposal("d1", "T1"));
    land(l, 10, [intent("d1", "T1"), intent("d2", "T2")]);
    const drive = async (id: string, taskId: string) => {
      const settled: string[] = [], bound: SessionRef = { taskId, role: "author", agent: "w-author", sessionId: "sess", family: "claude", transport: "acp" };
      const ops: SchedulerLedgerOps = { intent: i => getIntent(l.db, i), current: () => ({ specRev: 1, head: HEAD_A, round: 2, bound }),
        settle: async (_id, from, to, receipt) => { settled.push(`${from}→${to}`, receipt); return true; }, taken: () => null, now: () => 9000 };
      const worker = { route: "acp", fallbackReason: null, submit: async () => ({ status: "sent", route: "acp", messageKey: "m", evidence: "e" }) } as unknown as WorkerSession;
      const order = { taskId, specRev: 1, head: HEAD_A, round: 2, node: "write", step: "write", dedupKey: id, inputs: [], outputs: [], acceptance: [], writeBack: "" } as WorkOrder;
      return { outcome: await driveDispatch(ops, worker, bound, order), settled };
    };
    const sent = await drive("d1", "T1");
    expect(sent.outcome.kind).toBe("sent");
    expect(sent.settled.join(" ")).not.toContain("意图收件人与 session 不一致");
    // d2 had no retained plan (restart): null recipient, the existing driver path cancels it for a replan.
    expect(recipient(l, "d2")).toBeNull();
    const cancelled = await drive("d2", "T2");
    expect(cancelled.outcome).toEqual({ kind: "replan", reason: "意图收件人与 session 不一致" });
    expect(cancelled.settled[0]).toBe("pending→cancelled");
  }));

  test("[验收线 4] nothing retained: the row lands with a null recipient and no plan event, without throwing", withLedger(l => {
    expect(land(l, 10, [intent("d1", "T1")])).toMatchObject({ kind: "written" });
    expect(recipient(l, "d1")).toBeNull();
    expect(planEvents(l)).toEqual([]);
    // A ref without the lookup (X13, older callers) behaves the same even when a proposal is retained.
    retainPlan(proposal("d2", "T2"));
    writeExecutionProjection(l.db, view(11, { tasks: cards, workflows: flows, intents: [intent("d1", "T1"), intent("d2", "T2")] }), ref);
    expect(recipient(l, "d2")).toBeNull();
    expect(planEvents(l)).toEqual([]);
    expect(retainedPlanCount()).toBe(1);
  }));

  test("[验收线 5] update keeps the local recipient; a proposal for another card / node / action fills nothing and is reported once after commit", withLedger(l => {
    const observed: string[] = [], observe = (taskId: string, code: string) => { observed.push(`${taskId} ${code}`); };
    retainPlan(proposal("d1", "T1"));
    land(l, 10, [intent("d1", "T1")], { observe });
    // Update path: a later proposal under the same id must not rewrite the recipient or add a second event.
    retainPlan(proposal("d1", "T1", { recipient: "someone-else" }));
    land(l, 11, [intent("d1", "T1", { status: "submitted" })], { observe });
    expect(getIntent(l.db, "d1")).toMatchObject({ recipient: "w-author", status: "submitted" });
    expect(planEvents(l)).toHaveLength(1);
    expect(retainedPlan("d1")).toMatchObject({ recipient: "someone-else" });
    expect(observed).toEqual([]);
    retainPlan(proposal("x1", "T2"));
    retainPlan(proposal("x2", "T1", { node: "restate" }));
    retainPlan(proposal("x3", "T1", { action: "review" }));
    const center = [intent("d1", "T1", { status: "done" }), intent("x1", "T1"), intent("x2", "T1"), intent("x3", "T1")];
    land(l, 12, center, { observe });
    for (const id of ["x1", "x2", "x3"]) expect(recipient(l, id)).toBeNull();
    expect(planEvents(l)).toHaveLength(1);
    expect(observed).toEqual(["T1 projection_plan_mismatch:x1", "T1 projection_plan_mismatch:x2", "T1 projection_plan_mismatch:x3"]);
    for (const id of ["x1", "x2", "x3"]) expect(retainedPlan(id)).toBeNull();
    land(l, 13, center, { observe });
    expect(observed).toHaveLength(3);
  }));

  test("[验收线 5] a key the ledger already holds an event for is a mismatch, not a unique-constraint error", withLedger(l => {
    const observed: string[] = [];
    land(l, 10, [intent("d1", "T1")]);
    // d1's row landed without a proposal; d9's key is taken by hand to stand in for any earlier `scheduler:<id>` event.
    withProjectionScope(l.db, { featureId: "F", centerSeq: 11, intents: new Map([["d9", "T1"]]) }, () =>
      insertEvent(l.db, { actor: PROJECTION_ACTOR, now: 1, dedupKey: "scheduler:d9" }, { project: "p", target: "T1", kind: "scheduler", data: { op: "center-plan", plan: {} } }, true));
    retainPlan(proposal("d9", "T1"));
    expect(land(l, 12, [intent("d1", "T1"), intent("d9", "T1")], { observe: (t: string, c: string) => { observed.push(`${t} ${c}`); } })).toMatchObject({ kind: "written" });
    expect(recipient(l, "d9")).toBeNull();
    expect(observed).toEqual(["T1 projection_plan_mismatch:d9"]);
  }));

  test("[验收线 5] the store is bounded: past 256 entries the oldest is dropped, lookups never remove", () => {
    for (let n = 0; n <= PLAN_RETAIN_LIMIT; n++) retainPlan(proposal(`k${n}`, "T1"));
    expect(retainedPlanCount()).toBe(PLAN_RETAIN_LIMIT);
    expect(retainedPlan("k0")).toBeNull();
    expect(retainedPlan("k1")).toMatchObject({ id: "k1" });
    retainPlan(proposal("k1", "T1", { reason: "again" })); // re-retained = newest
    retainPlan(proposal("k-new", "T1"));
    expect(retainedPlan("k2")).toBeNull();
    expect(retainedPlan("k1")).toMatchObject({ reason: "again" });
    const copy = retainedPlan("k1")!;
    copy.resources.push("mutated");
    expect(retainedPlan("k1")!.resources).toEqual(["src/a.ts", "src/b.ts", "task:s1"]);
    expect(retainedPlanCount()).toBe(PLAN_RETAIN_LIMIT);
  });

  test("[验收线 6] a transaction that fails after the intents were written rolls back: the entry stays, nothing is reported, the retry lands it", withLedger(l => {
    const observed: string[] = [], observe = (taskId: string, code: string) => { observed.push(`${taskId} ${code}`); };
    land(l, 10, []);
    retainPlan(proposal("d1", "T1"));
    retainPlan(proposal("bad", "T2", { node: "elsewhere" }));
    // Resource writes run after writeIntents: a trigger makes that later step throw.
    l.db.run("CREATE TRIGGER s2f4_fail BEFORE INSERT ON scheduler_resources BEGIN SELECT RAISE(ABORT, 's2f4 resource write failed'); END");
    const intents = [intent("d1", "T1"), intent("bad", "T2")];
    expect(() => land(l, 11, intents, { observe })).toThrow();
    expect(l.rows("SELECT id FROM scheduler_intents")).toEqual([]);
    expect(planEvents(l)).toEqual([]);
    expect(observed).toEqual([]);
    expect(retainedPlan("d1")).not.toBeNull();
    expect(retainedPlan("bad")).not.toBeNull();
    l.db.run("DROP TRIGGER s2f4_fail");
    land(l, 11, intents, { observe });
    expect(recipient(l, "d1")).toBe("w-author");
    expect(getEventByDedup(l.db, "scheduler:d1")?.data.plan).toMatchObject({ id: "d1", recipient: "w-author" });
    expect(observed).toEqual(["T2 projection_plan_mismatch:bad"]);
    expect(retainedPlanCount()).toBe(0);
  }));
});

describe("S2F4 write gate: the projection token admits one more event, nothing else", () => {
  const draft = (target: string, data: Record<string, unknown> = { op: "center-plan", plan: {} }, kind: "scheduler" | "task" = "scheduler") =>
    ({ project: "p", target, kind, data });
  function attempt(l: Ledger, seq: number, dedupKey: string | undefined, e: ReturnType<typeof draft>, intents: ReadonlyMap<string, string> | null = new Map([["n1", "T1"]])) {
    return () => withProjectionScope(l.db, { featureId: "F", centerSeq: seq, ...(intents ? { intents } : {}) }, () => {
      // A card write in the same transaction: a refused event must take it down too.
      l.db.query("UPDATE tasks SET title = 'touched' WHERE id = 'T1'").run();
      return insertEvent(l.db, { actor: PROJECTION_ACTOR, now: 1, ...(dedupKey ? { dedupKey } : {}) }, e, true);
    });
  }
  test("[验收线 7] refused and rolled back: wrong op, wrong key, id outside this view (old projected intents included), wrong card, foreign feature, no set", withLedger(l => {
    land(l, 10, [intent("old", "T1")]);
    // A card of another feature in the same project.
    l.db.query(`INSERT INTO tasks (id, project, title, kind, stage, round, rev, specRev, extra, createdAt, updatedAt)
      SELECT 'X9', project, 'other', kind, stage, round, rev, specRev, ?, createdAt, updatedAt FROM tasks WHERE id = 'T1'`)
      .run(JSON.stringify({ sharedFeatureId: "other-feature" }));
    const events = () => l.rows("SELECT COUNT(*) AS n FROM events")[0]!.n as number, before = events();
    const refused: (() => unknown)[] = [
      attempt(l, 11, "scheduler:n1", draft("T1", { op: "plan", plan: {} })),
      attempt(l, 11, "scheduler:n1", draft("T1", { op: "center-projection" })),
      attempt(l, 11, "n1", draft("T1")),
      attempt(l, 11, undefined, draft("T1")),
      attempt(l, 11, "scheduler:n1:submitted", draft("T1")),
      attempt(l, 11, "scheduler:old", draft("T1")), // landed by an earlier projection, not in this view's set
      attempt(l, 11, "scheduler:n1", draft("T2")), // the set names T1 for n1
      attempt(l, 11, "scheduler:n9", draft("X9"), new Map([["n9", "X9"]])), // card of another feature
      attempt(l, 11, "scheduler:n1", draft("T1"), null), // a scope built without the view set
    ];
    for (const run of refused) {
      expect(run).toThrow("投影令牌与目标卡不符");
      expect(events()).toBe(before);
      expect(l.rows("SELECT title FROM tasks WHERE id = 'T1'")[0]!.title).toBe("card T1");
    }
    // The one admitted shape, and the card event the token always admitted.
    expect(attempt(l, 11, "scheduler:n1", draft("T1"))).not.toThrow();
    expect(getEventByDedup(l.db, "scheduler:n1")).toMatchObject({ kind: "scheduler", target: "T1", actor: PROJECTION_ACTOR });
    expect(attempt(l, 12, undefined, draft("T1", { op: "center-projection" }, "task"))).not.toThrow();
  }));

  test("[验收线 7] the set is frozen at scope entry and an actor name alone grants nothing", withLedger(l => {
    land(l, 10, []);
    const live = new Map([["n1", "T1"]]);
    expect(() => withProjectionScope(l.db, { featureId: "F", centerSeq: 11, intents: live }, () => {
      live.set("n2", "T1");
      return insertEvent(l.db, { actor: PROJECTION_ACTOR, now: 1, dedupKey: "scheduler:n2" }, draft("T1"), true);
    })).toThrow("投影令牌与目标卡不符");
    expect(() => insertEvent(l.db, { actor: PROJECTION_ACTOR, now: 1, dedupKey: "scheduler:n1" }, draft("T1"), true)).toThrow("投影身份缺少令牌");
    expect(() => insertEvent(l.db, { actor: "scheduler", now: 1, dedupKey: "scheduler:n1" }, draft("T1"), true)).toThrow("execution / migrating 卡禁止本机写入");
  }));
});
