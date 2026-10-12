import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTask } from "../src/lib/ledger-store.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { beginRetire, bindSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { withExecutorScope, type ExecutorFence } from "../src/lib/shared-ledger-v2-write-gate.js";
import { syncExecutionProjection, writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { center, executionMode, intent, ledger, ref, task, view, workflow, identity, type Ledger } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

const lease: ExecutorFence = { serviceGeneration: 1, epoch: 1, bootId: "boot-1", leaseId: "lease-1" };
const scheduler = (now: number) => ({ actor: "scheduler", now });
function scope<T>(l: Ledger, taskId: string, fn: () => T): T {
  return withExecutorScope(l.db, { featureId: "F", taskId, fence: lease, claimFence: null, leaseIdOf: f => (f as ExecutorFence).leaseId }, fn);
}
function plan(l: Ledger, taskId: string, id: string) {
  const causalSeq = (l.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  return planIntent(l.db, scheduler(3000), { id, taskId, taskRev: getTask(l.db, taskId)!.rev, workflowRev: 1, causalSeq,
    node: "restate", action: "ensure_session", reason: "create session", resources: [`task:${taskId.toLowerCase()}`] });
}
const merge = intent("m3", "T3", { action: "merge", node: "merge_deploy", status: "submitted", authorizationAskId: "ask", authorizationDigest: "d".repeat(64) });
const cards = (stage1 = "build") => [task("T1", { stage: stage1 }), task("T2"), task("T3", { stage: "merge" })];
const flows = ["T1", "T2", "T3"].map(id => workflow(id));

describe("S2P retention rules (real schema, foreign keys on) and S2V guard", () => {
  test("home-action intents, sessions, locks and merge-referenced intents survive; orphans are observed; guard follows the feature", async () => {
    const l = ledger(), observed: string[] = [];
    try {
      expect(l.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      writeFileSync(join(l.dir, "registry.json"), JSON.stringify({ socket: "", agents: { "worker": { runtime: "claude-code" } } }));
      l.setMode(executionMode);
      const observe = (taskId: string, code: string) => { observed.push(`${taskId} ${code}`); };
      writeExecutionProjection(l.db, view(10, { tasks: cards(), workflows: flows, intents: [merge] }), { ...ref, observe });
      // Home bookkeeping through S2G's executor token: a done ensure + its session, a submitted retire, a pending ensure lock.
      scope(l, "T1", () => plan(l, "T1", "e1"));
      scope(l, "T1", () => settleIntent(l.db, scheduler(3100), { id: "e1", from: "pending", to: "submitted" }));
      scope(l, "T1", () => bindSchedulerSession(l.db, scheduler(3200), { taskId: "T1", role: "author", intentId: "e1", agent: "worker",
        sessionId: "session-one", family: "claude", transport: "acp", registryPath: join(l.dir, "registry.json") }));
      scope(l, "T1", () => settleIntent(l.db, scheduler(3300), { id: "e1", from: "submitted", to: "done" }));
      writeExecutionProjection(l.db, view(11, { tasks: cards("verified"), workflows: flows, intents: [merge] }), { ...ref, observe });
      const retire = scope(l, "T1", () => beginRetire(l.db, scheduler(3400), "T1")).intent;
      scope(l, "T2", () => plan(l, "T2", "e2"));
      l.db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
        VALUES ('m3', 'T3', 'p', 'team/repository#7', 'feat/example', ?, '[]', 'merging', 3500, 3500)`).run("a".repeat(40));
      const local = () => ({
        intents: l.rows("SELECT * FROM scheduler_intents WHERE id IN (?, ?, ?, 'm3') ORDER BY id", "e1", "e2", retire.id),
        sessions: l.rows("SELECT * FROM scheduler_sessions"), merges: l.rows("SELECT * FROM scheduler_merges"),
        locks: l.rows("SELECT * FROM scheduler_resources WHERE intentId IN ('e1', 'e2') ORDER BY resource"),
      });
      const before = local();
      expect(before.intents.map(i => [i.id, i.action, i.status])).toEqual([["e1", "ensure_session", "done"], ["e2", "ensure_session", "pending"],
        ["m3", "merge", "submitted"], [retire.id, "retire", "submitted"]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
      expect(before.sessions.length).toBe(1);
      expect(before.locks.map(r => [r.intentId, r.resource, r.scope])).toEqual([["e2", "task:t2", "intent"]]);

      // A view without any home rows (m3 still there), then one that drops the merge-referenced intent.
      expect(writeExecutionProjection(l.db, view(12, { tasks: cards("verified"), workflows: flows, intents: [merge] }), { ...ref, observe }).kind).toBe("written");
      expect(local()).toEqual(before);
      expect(observed).toEqual([]);
      expect(writeExecutionProjection(l.db, view(13, { tasks: cards("verified"), workflows: flows }), { ...ref, observe })).toMatchObject({ kind: "written", orphans: ["m3"] });
      expect(local()).toEqual(before);
      expect(observed).toEqual(["T3 projection_orphan:m3"]);
      expect(l.rows("SELECT resource FROM scheduler_resources WHERE intentId='m3'").length).toBe(1); // a live orphan keeps its lock

      // The same card's next dispatch syncs normally next to the home lock.
      const dispatch = intent("d2", "T2", { status: "submitted" });
      const sync = syncExecutionProjection(l.db, { identity: () => identity, snapshot: async () => view(14, { tasks: cards("verified"), workflows: flows, intents: [dispatch] }), observe });
      expect((await sync("p", "F")).kind).toBe("written");
      expect(l.rows("SELECT id, status FROM scheduler_intents WHERE id='d2'")).toEqual([{ id: "d2", status: "submitted" }]);
      expect(local()).toEqual(before);

      // S2V guard: projected cards are guarded; token-less deletes are ignored, the projection itself releases center locks.
      expect(l.rows("SELECT taskId FROM v2_projection_guard ORDER BY taskId").map(r => r.taskId)).toEqual(["T1", "T2", "T3"]);
      const d2Lock = l.rows("SELECT * FROM scheduler_resources WHERE intentId='d2'");
      expect(d2Lock.length).toBe(1);
      l.db.query("DELETE FROM scheduler_resources WHERE intentId='d2'").run();
      expect(l.rows("SELECT * FROM scheduler_resources WHERE intentId='d2'")).toEqual(d2Lock);
      writeExecutionProjection(l.db, view(15, { tasks: cards("verified"), workflows: flows, intents: [{ ...dispatch, status: "done" }] }), { ...ref, observe });
      expect(l.rows("SELECT * FROM scheduler_resources WHERE intentId='d2'")).toEqual([]);
      expect(local()).toEqual(before);

      // X13B-style revert: feature back to planning under batch B; the final planning view releases the guard.
      const { epoch: _epoch, ...planned } = executionMode.centerExecution!;
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned, migrating: { batchId: "B", kind: "revert" } });
      const revert = view(16, { tasks: cards("verified"), workflows: flows, intents: [{ ...dispatch, status: "done" }] }, { authorityMode: "planning", epoch: 2 });
      expect(writeExecutionProjection(l.db, revert, { ...ref, batchId: "B", center, observe }).kind).toBe("written");
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([]);
      expect(local()).toEqual(before);
    } finally { l.close(); }
  });
});
