/**
 * dispatch-recovery-CVCOUNT1 (audit a06 A06-02 / A06-03) · the convergence count starts at the formal event that put the card on
 * its spec revision (a `workflow` set or the `workflow_resume` that changed the revision), and "already swapped" is read from the
 * real rounds of the unbroken range. Synthetic ledgers only: the planner is pure, nothing here touches a service.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { FIX_STRATEGY_RULE } from "../src/lib/fix-strategy.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";

const head = (r: number) => r.toString(16).padStart(40, "0");
const author: WorkerRef = { agent: "agent-author", sessionId: "s-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-rv", sessionId: "s-rv", taskId: "T1", family: "codex", source: "local" };
const p1 = (id: string) => ({ findingId: id, family: id, severity: "P1" as const, probe: `[验收线 1] src/lib/x.ts:1 ${id}` });
type Row = ReturnType<typeof p1>;
const reviewIntent = (r: number) => `t68:s${r}:r${r}:adversarial_review:a0`;

/** A card's ledger written in order; `specRev` is the revision the card is on while the next events are appended. */
function ledger() {
  const events: LedgerEvent[] = [];
  let specRev = 1;
  const ev = (kind: LedgerEvent["kind"], data: Record<string, unknown>, actor = "scheduler") => {
    events.push({ seq: events.length + 1, ts: events.length + 1, actor, project: "p", target: "T1", kind, text: "", data, dedupKey: null });
  };
  ev("task", { op: "new" }, "agent-pm");
  ev("scheduler", { op: "workflow", mode: "auto", specRev: 1, workflowRev: 1 }, "agent-pm");
  const enter = (r: number) => {
    ev("stage", { from: r === 1 ? "build" : "fix", to: "review", round: r });
    ev("deliver", { round: r, headSHA: head(r) }, author.agent);
    ev("scheduler", { op: "plan", id: reviewIntent(r), node: "adversarial_review", action: "review", recipient: reviewer.agent, head: head(r), round: r });
    ev("scheduler", { op: "settle", id: reviewIntent(r), from: "submitted", to: "done" });
    ev("scheduler", { op: "order_taken", id: reviewIntent(r) }, reviewer.agent);
  };
  const api = {
    events,
    /** A round that ended in a valid verdict; the card then sits in review until `toFix`. */
    verdict(r: number, rows: Row[]) {
      enter(r);
      ev("review", { round: r, head: head(r), reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: "codex",
        path: `reviews/T1-r${r}.md`, verdict: "changes", findings: rows, p0: 0, p1: rows.length, p2: 0 }, reviewer.agent);
      return api;
    },
    toFix(r: number) { ev("stage", { from: "review", to: "fix", round: r }); return api; },
    /** Dispatched and taken, then interrupted: no verdict, the fallback records the round it cut off. */
    interrupted(r: number) {
      enter(r);
      ev("scheduler", { op: "fallback_manual", reason: "审查员过载", abortedReview: { round: r } });
      ev("scheduler", { op: "workflow_resume", manual: true, from: "manual", fromSpecRev: specRev, specRev, workflowRev: 1 }, "agent-pm");
      ev("stage", { from: "review", to: "fix", round: r }, "agent-pm");
      return api;
    },
    /** The swap the runtime journals once a fix_swap is done (fix-strategy-lifecycle.ts convergenceEvent). */
    swapped(r: number, mode: "fresh_session" | "other_family", rows: Row[]) {
      ev("scheduler", { op: "fix_strategy", round: r, specRev, mode, family: mode === "other_family" ? "codex" : "claude", findings: rows });
      return api;
    },
    /** PM rewrites the spec and hands the card back with the formal `ledger workflow-resume`: no `workflow` event is written. */
    specResume(to: number) {
      ev("task", { op: "set", patch: { specRev: to } }, "agent-pm");
      ev("scheduler", { op: "workflow_resume", manual: true, from: "manual", fromSpecRev: specRev, specRev: to, workflowRev: 2 }, "agent-pm");
      specRev = to;
      return api;
    },
    snapshot(stage: Stage, round: number): PlannerSnapshot {
      const plan = events.findLast((e) => e.data.op === "plan")!, taken = events.findLast((e) => e.data.op === "order_taken")!;
      const task: LedgerTask = { id: "T1", project: "p", itemId: null, title: "CVCOUNT", kind: "code", stage, stageBefore: null, round,
        agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null, headSHA: head(round),
        spec: null, specRev, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1 };
      const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
        fallback: "PM 接管", specRev, rev: 1, createdAt: 1, updatedAt: 1 };
      const sent: SchedulerIntent = { id: `review-r${round}`, taskId: "T1", project: "p", node: "adversarial_review", action: "review",
        recipient: reviewer.agent, causalSeq: plan.seq - 1, eventSeq: plan.seq, taskRev: 1, specRev, head: head(round), templateVersion: 2, status: "done",
        attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 };
      return { task, workflow, events: [...events], intents: [sent], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/x.ts"], heldResources: [],
        workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer, uiGate: { state: "none" }, screenshotsDigest: null,
        reviewDispatches: [{ intentId: sent.id, round, head: head(round), reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: taken.seq }] };
    },
  };
  return api;
}

const X = p1("race"), Y = p1("leak");
/** Old spec: the same P1 twice (and the swap that answered it), then an interrupted round, then a new spec handed back formally. */
const resumedOnNewSpec = () => ledger().verdict(1, [X]).toFix(1).verdict(2, [X]).toFix(2).swapped(2, "fresh_session", [X])
  .interrupted(3).specResume(2);
/** One spec: valid failures in rounds 1 and 2 (fresh session done in 2), rounds 3 and 4 interrupted. */
const interruptedAfterSwap = () => ledger().verdict(1, [X]).toFix(1).verdict(2, [X]).toFix(2).swapped(2, "fresh_session", [X])
  .interrupted(3).interrupted(4);

describe("验收线 1 · a formal workflow-resume onto a new spec starts the count", () => {
  test("the new spec's first P1 goes to a plain fix dispatch, not a fix_swap", () => {
    const l = resumedOnNewSpec().verdict(4, [X]).toFix(4);
    expect(planScheduler(l.snapshot("fix", 4))).toMatchObject({ kind: "intent", action: "dispatch", recipient: author.agent });
    expect(l.events.filter((e) => e.data.op === "workflow")).toHaveLength(1); // the boundary is read, never written as a new workflow event
  });

  test("neither the review exit nor the fix order carries the two-round warning", () => {
    const l = resumedOnNewSpec().verdict(4, [X]);
    expect(planScheduler(l.snapshot("review", 4))).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix", workOrder: { fallbackWarning: null } });
    expect(planScheduler(l.toFix(4).snapshot("fix", 4))).toMatchObject({ kind: "intent", workOrder: { fallbackWarning: null } });
  });

  test("the new spec still counts its own rounds: a second same P1 swaps the session", () => {
    const l = resumedOnNewSpec().verdict(4, [X]).toFix(4).verdict(5, [X]);
    expect(planScheduler(l.snapshot("review", 5))).toMatchObject({ kind: "intent", targetStage: "fix", workOrder: { fallbackWarning: FIX_STRATEGY_RULE } });
    expect(planScheduler(l.toFix(5).snapshot("fix", 5))).toMatchObject({ kind: "intent", action: "fix_swap" });
  });

  test("a hand-back on the same spec is no boundary: the interrupted round keeps both sides consecutive", () => {
    const l = ledger().verdict(1, [X]).toFix(1).interrupted(2).verdict(3, [X]);
    expect(planScheduler(l.snapshot("review", 3))).toMatchObject({ kind: "intent", targetStage: "fix", workOrder: { fallbackWarning: FIX_STRATEGY_RULE } });
    expect(planScheduler(l.toFix(3).snapshot("fix", 3))).toMatchObject({ kind: "intent", action: "fix_swap" });
  });
});

describe("验收线 2 · the swap already done inside the unbroken range is found across interrupted rounds", () => {
  test("failures in 1, 2 and 5 with 3 and 4 interrupted: round 5 dispatches, it does not swap the session again", () => {
    const l = interruptedAfterSwap().verdict(5, [X]).toFix(5);
    const fix = planScheduler(l.snapshot("fix", 5));
    expect(fix).toMatchObject({ kind: "intent", action: "dispatch", recipient: author.agent, workOrder: { fallbackWarning: FIX_STRATEGY_RULE } });
  });

  test("another finding's swap does not cover this one", () => {
    const l = interruptedAfterSwap().verdict(5, [Y]).toFix(5).verdict(6, [Y]).toFix(6);
    expect(planScheduler(l.snapshot("fix", 6))).toMatchObject({ kind: "intent", action: "fix_swap", reason: expect.stringContaining("换修复会话") });
  });

  test("a finding that was resolved and came back starts a new range: the old swap is outside it", () => {
    const l = ledger().verdict(1, [X]).toFix(1).verdict(2, [X]).toFix(2).swapped(2, "fresh_session", [X])
      .verdict(3, [Y]).toFix(3).verdict(4, [X]).toFix(4).verdict(5, [X]).toFix(5);
    expect(planScheduler(l.snapshot("fix", 5))).toMatchObject({ kind: "intent", action: "fix_swap", reason: expect.stringContaining("换修复会话") });
  });

  test("a swap journalled under another spec revision does not count for this one", () => {
    const l = resumedOnNewSpec().verdict(4, [X]).toFix(4).verdict(5, [X]).toFix(5);
    expect(l.events.some((e) => e.data.op === "fix_strategy" && e.data.specRev === 1)).toBe(true);
    expect(planScheduler(l.snapshot("fix", 5))).toMatchObject({ kind: "intent", action: "fix_swap" });
  });

  test("four valid failures still switch the model family, once", () => {
    const l = ledger().verdict(1, [X]).toFix(1).verdict(2, [X]).toFix(2).swapped(2, "fresh_session", [X])
      .interrupted(3).verdict(4, [X]).toFix(4).verdict(5, [X]).toFix(5);
    expect(planScheduler(l.snapshot("fix", 5))).toMatchObject({ kind: "intent", action: "fix_swap", reason: expect.stringContaining("换作者模型家族") });
    l.swapped(5, "other_family", [X]).verdict(6, [X]).toFix(6);
    expect(planScheduler(l.snapshot("fix", 6))).toMatchObject({ kind: "intent", action: "dispatch" });
  });
});
