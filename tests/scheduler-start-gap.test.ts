/** RESTATEGO1 · a card in build with no start order: the next pass dispatches the write order, or a note names what it waits for. */
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler, type PlannerDecision } from "../src/lib/scheduler-plan.js";
import { START_GAP_ESCALATE_MS, START_GAP_MS, startGap } from "../src/lib/scheduler-start-gap.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const gapNotes = (f: F) => listEvents(f.db, { project: "p", target: "T1" })
  .filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "startDeliveryConfirm" && String(e.data.actionKey).startsWith("start-gap:"));
const todos = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pm_todo" && e.data.kind === "start_gap");

/** A start_node card on a center replica: named local author, the replica's feature id on the card, v3 auto workflow. */
function centerCard(mode: RecoveryMode = "on") {
  const f = autoFixture();
  f.db.query("UPDATE tasks SET extra = json_set(extra, '$.sharedFeatureId', 'n7-feature-a') WHERE id = 'T1'").run();
  f.db.query("UPDATE task_workflows SET templateVersion = 3 WHERE taskId = 'T1'").run();
  f.tickDeps.recoveryPolicy = policy(mode);
  // the scheduler identity's CLI runs leased in the service; pm-todo needs that lease
  f.tickDeps.manager = (...args) => f.cliWith({ assertLease: () => {} }, "scheduler", ...args.slice(1));
  return f;
}

describe("[验收线 1] start_node center-replica card after approve_restate", () => {
  test("the next pass plans and sends the write order (v3: the executor's own restate record releases build)", async () => {
    const f = centerCard();
    try {
      expect(getWorkflow(f.db, "T1")?.templateVersion).toBe(3);
      await f.tick(); // author session
      await f.tick(); // restate order
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "restate→build" }); // approve_restate
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(f.intents().at(-1)).toMatchObject({ node: "write", action: "dispatch", status: "done", recipient: "agent-task-one" });
      expect(gapNotes(f)).toEqual([]); // an ordinary first dispatch leaves no gap note
    } finally { f.close(); }
  });

  test("a gate holds the write order: past the threshold one note names the wait code, reason and time in build; cleared → re-planned", async () => {
    const f = centerCard();
    try {
      await f.tick();
      await f.tick();
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      await f.tick(); // restate → build
      await f.cli("pm", "freeze", "--reason", "测试：冻结队列", "--project", "p");
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      expect(gapNotes(f)).toEqual([]); // inside the threshold
      f.advance(START_GAP_MS);
      await f.tick();
      await f.tick();
      const notes = gapNotes(f);
      expect(notes.map((e) => e.data.actionKey)).toEqual(["start-gap:s1:wait", "start-gap:s1:wait:queue_frozen"]);
      expect(notes[0].text).toMatch(/在 build 已 1\d 分钟没有开工单，等 queue_frozen：项目队列已冻结/);
      expect(notes[0].data).toMatchObject({ code: "queue_frozen", waitedMs: expect.any(Number), since: expect.any(Number) });
      expect(todos(f)).toEqual([]);
      f.advance(START_GAP_ESCALATE_MS);
      await f.tick();
      await f.tick();
      expect(todos(f)).toHaveLength(1); // still blocked after an hour: one PM todo, never repeated
      await f.cli("pm", "unfreeze", "--project", "p");
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(gapNotes(f).map((e) => e.data.actionKey)).toContain("start-gap:s1:replanned");
      expect(f.intents().at(-1)).toMatchObject({ node: "write", status: "done" });
    } finally { f.close(); }
  });

  test("[验收线 4] key off: no note, no todo — the pass decides exactly as before", async () => {
    const f = centerCard("off");
    try {
      await toBuild(f);
      await f.cli("pm", "freeze", "--reason", "测试：冻结队列", "--project", "p");
      f.advance(START_GAP_ESCALATE_MS * 2);
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "项目队列已冻结，不派新活" });
      expect(gapNotes(f)).toEqual([]);
      expect(todos(f)).toEqual([]);
    } finally { f.close(); }
  });
});

describe("startGap (pure)", () => {
  test("only an auto card in build without a sent write order, past the threshold; a done stage intent is no delivery", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      const snap = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 0 });
      const since = snap.events.findLast((e) => e.kind === "stage" && e.data.to === "build")!.ts;
      expect(snap.intents.some((i) => i.node === "approve_restate" && i.status === "done")).toBe(true);
      const placement: PlannerDecision = { kind: "wait", code: "placement", reason: "等 claude / codex 空位" };
      expect(startGap(snap, placement, since + START_GAP_MS - 1)).toEqual({ kind: "none" });
      expect(startGap(snap, placement, since + START_GAP_MS)).toEqual({ kind: "gap", since, waitedMs: START_GAP_MS, code: "placement", reason: "等 claude / codex 空位" });
      const plan = planScheduler(snap);
      expect(plan).toMatchObject({ kind: "intent", node: "write" });
      expect(startGap(snap, plan, since + START_GAP_MS)).toEqual({ kind: "replanned", since, waitedMs: START_GAP_MS });
      await f.tick(); // write sent
      const after = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 0 });
      expect(startGap(after, placement, since + 10 * START_GAP_MS)).toEqual({ kind: "none" });
    } finally { f.close(); }
  });
});
