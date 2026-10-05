import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { getTask } from "../src/lib/ledger-store.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { pauseFixture } from "./scheduler-merge-retry-pause.test.js";

const resumeCli = (f: Awaited<ReturnType<typeof pauseFixture>>, actor = "pm") => f.cli(actor, "workflow-resume", "T1",
  "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--reason", "handoff finished");

describe("MRRESTP a still-pending merge intent cancelled by PM's pause", () => {
  test("[验收线 1,3] pause cancels the pending intent and frees its resources; resume plans exactly one retry", async () => {
    const f = await pauseFixture("pending");
    try {
      expect(f.db.query("SELECT * FROM scheduler_merges WHERE intentId=?").all(f.id)).toEqual([]);
      const before = f.evidence();
      f.pause();
      expect(getIntent(f.db, f.id)!.status).toBe("cancelled");
      expect(f.db.query("SELECT * FROM scheduler_resources WHERE intentId=?").all(f.id)).toEqual([]);
      expect(f.released()).toBe(false);
      expect(await resumeCli(f)).toMatchObject({ ok: true });
      expect(f.released()).toBe(true);
      const retry = f.plan().intent;
      const other = new Database(f.dir + "/ledger.sqlite");
      try { expect(f.plan(other)).toMatchObject({ duplicate: true, intent: { id: retry.id } }); } finally { other.close(); }
      for (let n = 0; n < 2; n++) expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      expect(f.evidence()).toEqual(before);
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action='merge'").get()).toEqual({ n: 2 });
      // The retry's own later cancellation is a new one: the earlier handback does not cover it.
      f.pause();
      expect(getIntent(f.db, retry.id)!.status).toBe("cancelled");
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "wait", code: "manual" });
      expect(mergeRetryReleased(f.task(), f.snapshot().events, getIntent(f.db, retry.id)!)).toBe(false);
      await resumeCli(f);
      expect(mergeRetryReleased(f.task(), f.snapshot().events, getIntent(f.db, retry.id)!)).toBe(true);
    } finally { f.close(); }
  });

  test("[验收线 1,3] a cancellation PM's pause did not perform, or any later trace of the intent, is not proof", async () => {
    const f = await pauseFixture("pending");
    try {
      settleIntent(f.db, f.at("scheduler"), { id: f.id, from: "pending", to: "cancelled", receipt: "stale" });
      f.pause();
      await resumeCli(f);
      expect(f.released()).toBe(false);
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    } finally { f.close(); }
    const g = await pauseFixture("pending");
    try {
      expect(await g.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "session missing")).toMatchObject({ ok: true });
      await resumeCli(g);
      expect(g.released()).toBe(false);
    } finally { g.close(); }
  });

  test("[验收线 1,3] forged, imported or mismatched evidence never releases", async () => {
    const f = await pauseFixture("pending");
    try {
      for (const actor of ["agent-task-one", "agent-pm-forged", "scheduler", "peer:fake"]) expect(() => f.pause(actor)).toThrow(/只有项目 PM/);
      f.pause();
      for (const actor of ["agent-task-one", "agent-pm-forged", "scheduler", "peer:fake"]) expect(await resumeCli(f, actor)).toMatchObject({ ok: false });
      await resumeCli(f);
      const s = f.snapshot(), intent = getIntent(f.db, f.id)!;
      const release = (events = s.events, task = s.task, old = intent) => mergeRetryReleased(task, events, old);
      expect(release()).toBe(true);
      const pause = s.events.find((e) => e.data.op === "workflow" && e.data.mode === "manual")!;
      const resume = s.events.find((e) => e.data.op === "workflow_resume")!;
      const plan = s.events.find((e) => e.seq === intent.eventSeq)!;
      const patch = (target: typeof pause, p: Record<string, unknown>, top: Record<string, unknown> = {}) =>
        s.events.map((e) => e === target ? { ...e, ...top, data: { ...e.data, ...p } } : e);
      for (const [target, p, top] of [
        [pause, { cancelledIntents: [] }], [pause, { hold: "x" }], [pause, { specRev: 2 }], [pause, { imported: true }],
        [pause, {}, { actor: "scheduler" }], [pause, { takeover: undefined }],
        [resume, { workflowRev: 999 }], [resume, { manual: false }], [resume, {}, { actor: "scheduler" }], [resume, { imported: true }],
        [plan, {}, { actor: "pm" }], [plan, { action: "stage" }], [plan, {}, { dedupKey: null }],
      ] as [typeof pause, Record<string, unknown>, Record<string, unknown>?][]) expect(release(patch(target, p, top))).toBe(false);
      expect(release(s.events.filter((e) => e !== pause))).toBe(false);
      const last = s.events.at(-1)!;
      const extra = (data: Record<string, unknown>, kind: typeof last.kind = "scheduler") => [...s.events, { ...last, seq: last.seq + 1, kind, actor: "scheduler", data }];
      expect(release(extra({ op: "settle", id: intent.id, from: "pending", to: "submitted" }))).toBe(false);
      expect(release(extra({ op: "merge_phase", intentId: intent.id, phase: "ready" }))).toBe(false);
      expect(release(extra({ headSHA: "b".repeat(40) }, "deliver"))).toBe(false);
      for (const p of [{ round: 2 }, { specRev: 2 }, { headSHA: "b".repeat(40) }]) expect(release(s.events, { ...s.task, ...p })).toBe(false);
      for (const p of [{ head: "b".repeat(40) }, { taskId: "other" }, { status: "submitted" as const }]) expect(release(s.events, s.task, { ...intent, ...p })).toBe(false);
      expect(release(s.events.map((e) => e === resume ? { ...e, project: "other" } : e))).toBe(false);
    } finally { f.close(); }
  });

  test("[验收线 1] a submitted intent cannot be paused into the pending path: resume refuses until the journal settles", async () => {
    const f = await pauseFixture("pending");
    try {
      settleIntent(f.db, f.at("scheduler"), { id: f.id, from: "pending", to: "submitted", receipt: "sent" });
      f.pause();
      expect(getIntent(f.db, f.id)!.status).toBe("submitted");
      expect(await resumeCli(f)).toMatchObject({ ok: false });
      expect(getTask(f.db, "T1")!.headSHA).toBeTruthy();
    } finally { f.close(); }
  });
});
