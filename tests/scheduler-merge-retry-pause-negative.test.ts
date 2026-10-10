import { describe, expect, test } from "bun:test";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { bounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { carryReceipt } from "../src/lib/scheduler-merge.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { H1 } from "./scheduler-auto-helpers.js";
import { pauseFixture } from "./scheduler-merge-retry-pause.test.js";

describe("MRREST fail closed", () => {
  test("[验收线 1,3] official writers reject executor, fake PM prefix and scheduler handback", async () => {
    const f = await pauseFixture();
    try {
      for (const actor of ["agent-task-one", "agent-pm-forged", "scheduler", "peer:fake"]) expect(() => f.pause(actor)).toThrow(/只有项目 PM/);
      f.pause(); f.step("resolved", "paused");
      const before = f.snapshot().events;
      for (const actor of ["agent-task-one", "agent-pm-forged", "scheduler", "peer:fake"]) expect(() => f.resume(actor)).toThrow(/只有项目 PM/);
      expect(f.snapshot().events).toEqual(before);
      expect(f.released()).toBe(false);
      f.resume("master");
      expect(f.released()).toBe(true);
    } finally { f.close(); }
  });

  test("[验收线 1,3] missing or mismatched durable evidence never releases a cancelled intent", async () => {
    const f = await pauseFixture("updating");
    try {
      f.pause(); f.step("resolved", "paused"); f.resume();
      const s = f.snapshot(), intent = getIntent(f.db, f.id)!;
      const release = (events = s.events, task = s.task, old = intent) => mergeRetryReleased(task, events, old);
      expect(release()).toBe(true);
      for (const op of ["workflow_resume", "workflow", "merge_phase", "settle"]) {
        expect(release(s.events.filter((e) => e.data.op !== op))).toBe(false);
      }
      for (const key of ["project", "target"] as const) {
        expect(release(s.events.map((e) => e.data.op === "workflow_resume" ? { ...e, [key]: "other" } : e))).toBe(false);
        expect(release(s.events.map((e) => e.data.outcome === "cancelled" ? { ...e, [key]: "other" } : e))).toBe(false);
      }
      for (const patch of [{ taskId: "other" }, { project: "other" }, { specRev: 2 }, { head: "b".repeat(40) }, { id: "other" }]) {
        expect(release(s.events, s.task, { ...intent, ...patch })).toBe(false);
      }
      for (const patch of [{ round: 2 }, { specRev: 2 }, { headSHA: "b".repeat(40) }]) expect(release(s.events, { ...s.task, ...patch })).toBe(false);
      const alterations = [
        { op: "workflow_resume", patch: { manual: false } }, { op: "workflow_resume", patch: { from: "auto" } },
        { op: "workflow_resume", patch: { stage: "fix" } }, { op: "workflow_resume", patch: { specRev: 2 } },
        { op: "workflow_resume", patch: { fromSpecRev: 2 } }, { op: "workflow_resume", patch: { workflowRev: 999 } },
        { op: "workflow", patch: { specRev: 2 } }, { op: "workflow", patch: { templateVersion: 3 } },
        { op: "workflow", patch: { manual: false } }, { op: "workflow", patch: { op: "fallback_manual" } },
      ];
      for (const { op, patch } of alterations) expect(release(s.events.map((e) => e.data.op === op ? { ...e, data: { ...e.data, ...patch } } : e))).toBe(false);
      for (const actor of ["agent-task-one", "agent-pm-forged"]) {
        expect(release(s.events.map((e) => e.data.outcome === "cancelled" ? { ...e, actor } : e))).toBe(false);
      }
      expect(release(s.events.map((e) => e.data.op === "workflow_resume" ? { ...e, actor: "scheduler" } : e))).toBe(false);
      expect(release(s.events.map((e) => e.data.outcome === "cancelled" ? { ...e, dedupKey: null } : e))).toBe(false);
      expect(release(s.events.map((e) => e.data.outcome === "cancelled" ? { ...e, data: { ...e.data, from: "merging" } } : e))).toBe(false);
      expect(release(s.events.map((e) => e.data.op === "workflow_resume" ? { ...e, seq: intent.eventSeq - 1 } : e))).toBe(false);
      expect(release(s.events.map((e) => e.data.op === "workflow_resume" ? { ...e, data: { ...e.data, imported: true } } : e))).toBe(false);
      expect(release(s.events.map((e) => ({ ...e, text: "PM pause", data: { ...e.data, receipt: "PM pause" } })))).toBe(true);
    } finally { f.close(); }
  });

  test("[验收线 1,3] CI failure, conflict and update failure are bounces, never pauses", async () => {
    for (const cause of ["ci_fail", "conflict", "update_fail"] as const) {
      const f = await pauseFixture("await_ci");
      try {
        f.step("resolved", bounceReceipt({ cause, prHead: H1, mainHead: "b".repeat(40),
          checks: [{ name: "check", link: "https://github.com/x/y/actions/runs/1" }], error: "refused" }));
        f.pause(); f.resume();
        expect(f.released()).toBe(false);
        expect(f.task().stage).toBe("fix");
        expect(planScheduler(f.snapshot())).not.toMatchObject({ kind: "intent", action: "merge" });
      } finally { f.close(); }
    }
  });

  test("[验收线 1,3] merging and unknown retain their slot and cannot be handed back unresolved", async () => {
    const f = await pauseFixture("await_ci");
    try {
      f.step("merging"); f.pause();
      expect(() => f.step("resolved", "paused")).toThrow(/不能从/);
      f.step("unknown", "merge sent; uncertain effect");
      expect(() => f.resume()).toThrow(/结果未定/);
      expect(f.released()).toBe(false);
      expect(f.db.query("SELECT intentId FROM scheduler_resources WHERE resource='merge:p'").get()).toEqual({ intentId: f.id });
    } finally { f.close(); }
  });

  test("[验收线 2,3] a real audited main carry keeps the old review; an unaudited chain cannot", async () => {
    const f = await pauseFixture("updating");
    try {
      const to = "b".repeat(40);
      f.step("await_ci", carryReceipt({ oldHead: H1, newHead: to, mainParent: "c".repeat(40), mainHead: "d".repeat(40), diffHash: "e".repeat(64) })
        + carryChainSuffix([{ previousHead: H1, head: to, mainParent: "c".repeat(40) }]), to);
      const before = f.evidence();
      f.pause(); f.step("resolved", "paused"); f.resume();
      expect(f.plan().intent.head).toBe(to);
      expect(f.evidence()).toEqual(before);
      const events = f.snapshot().events, old = getIntent(f.db, f.id)!;
      expect(mergeRetryReleased(f.task(), events.filter((e) => !e.data.carrySeq), old)).toBe(false);
      for (const patch of [{ actor: "pm" }, { data: { from: H1, to, op: "review_carry", intentId: f.id, round: 2, specRev: 1 } }]) {
        expect(mergeRetryReleased(f.task(), events.map((e) => e.data.op === "review_carry" ? { ...e, ...patch } : e), old)).toBe(false);
      }
    } finally { f.close(); }
  });

  test("[验收线 2,3] pause release leaves review, family, dispatch, UI, queue and manual holds intact", async () => {
    const f = await pauseFixture();
    try {
      f.pause(); f.step("resolved", "paused"); f.resume();
      const s = f.snapshot();
      expect(planScheduler({ ...s, queueFrozen: true })).toMatchObject({ kind: "wait", code: "queue_frozen" });
      expect(planScheduler({ ...s, reviewDispatches: [] })).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
      expect(planScheduler({ ...s, workflow: { ...s.workflow!, authorFamily: "codex" } })).toMatchObject({ kind: "escalate" });
      for (const severity of ["P0", "P1"]) {
        const events = s.events.map((e) => e.kind === "review" ? { ...e, data: { ...e.data, verdict: "changes", p0: severity === "P0" ? 1 : 0,
          p1: severity === "P1" ? 1 : 0, findings: [{ findingId: "block", family: "safety", severity, probe: "[回归] blocks merge" }] } } : e);
        expect(planScheduler({ ...s, events })).toMatchObject({ kind: "escalate", code: "merge_review_changes" });
      }
      expect(planScheduler({ ...s, workflow: { ...s.workflow!, template: "ui" }, ownerVisual: true }))
        .toMatchObject({ kind: "escalate", code: "merge_ui_unapproved" });
      f.pause("owner", "owner hold");
      expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
      expect(f.released()).toBe(false);
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "wait", code: "manual" });
    } finally { f.close(); }
  });
});
