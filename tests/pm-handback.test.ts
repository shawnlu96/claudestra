/**
 * PMHAND1 pure judgements (src/lib/pm-handback.ts) and the planner's 11a path: a review verdict older than the card's latest PM
 * hand-back is not this round's (normal review dispatch, tagged), a newer unsolicited one still escalates review_unsolicited;
 * the shared retired / hold rules; verifyAfterResolve's effective mode without configuration.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { HANDBACK_REVIEW_TAG, holdLiftedBy, liveBinding, reviewBeforeHandback, standingHold } from "../src/lib/pm-handback.js";
import { VERIFY_AFTER_RESOLVE, verifyAfterResolveMode } from "../src/lib/pm-handback-verify.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { SchedulerSession } from "../src/lib/scheduler-sessions.js";

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}, actor = "agent-author"): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor, project: "p", target: "T1", text: "", dedupKey: null });
const task = (stage: Stage, round: number): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "PMHAND1", kind: "code", stage, stageBefore: null, round,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const review = (seq: number): LedgerEvent => event(seq, "review", { round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId,
  reviewerFamily: reviewer.family, path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0 });
const handback = (seq: number, manual = true): LedgerEvent =>
  event(seq, "scheduler", { op: "workflow_resume", from: "manual", specRev: 1, ...(manual ? { manual: true } : { auto: true }) }, manual ? "agent-pm" : "scheduler");
/** A card in review, round 1, delivered at #19; the events after it are the case's. */
const snapshot = (...after: LedgerEvent[]): PlannerSnapshot => ({
  task: task("review", 1), workflow, events: [event(1, "task", { op: "new" }), event(11, "stage", { from: "build", to: "review", round: 1 }),
    event(19, "deliver", { round: 1, headSHA: HEAD }), ...after],
  intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});

afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); });

describe("[验收线 3] review verdicts before / after the PM hand-back", () => {
  test("a hand-dispatched verdict older than the hand-back: normal review dispatch on the current head, tagged, no escalation", () => {
    const d = planScheduler(snapshot(review(20), handback(25)));
    expect(d).toMatchObject({ kind: "intent", action: "review", recipient: reviewer.agent });
    expect(d.kind === "intent" && d.reason.startsWith(HANDBACK_REVIEW_TAG)).toBe(true);
  });

  test("an unsolicited verdict after the hand-back (or with no hand-back, or after the scheduler's own resume) still escalates", () => {
    expect(planScheduler(snapshot(handback(18), review(20)))).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    expect(planScheduler(snapshot(review(20)))).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    expect(planScheduler(snapshot(review(20), handback(25, false)))).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
  });

  test("the dispatch the planner made in its place is the usual in-flight wait while it runs", () => {
    const s = snapshot(review(20), handback(25));
    const i: SchedulerIntent = { id: "rv", taskId: "T1", project: "p", node: "adversarial_review", action: "review", recipient: reviewer.agent,
      causalSeq: 25, eventSeq: 26, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "submitted", attempts: 0, receipt: null,
      reason: `${HANDBACK_REVIEW_TAG} x`, createdAt: 1, updatedAt: 1 };
    expect(planScheduler({ ...s, intents: [i] })).toMatchObject({ kind: "wait", code: "in_flight" });
  });

  test("a review intent the scheduler finished before the hand-back no longer holds the dispatch; one planned after it still does", () => {
    const intent = (id: string, status: SchedulerIntent["status"]): SchedulerIntent => ({ id, taskId: "T1", project: "p", node: "adversarial_review",
      action: "review", recipient: reviewer.agent, causalSeq: 11, eventSeq: 0, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status,
      attempts: 1, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 });
    const plan = (seq: number, id: string) => event(seq, "scheduler", { op: "plan", id, node: "adversarial_review", action: "review" }, "scheduler");
    // round 2 auto review done (#20 plan), PM took over and hand-dispatched a review (#22), hand-back at #25
    const before = { ...snapshot(plan(20, "rv1"), review(22), handback(25)), intents: [intent("rv1", "done")] };
    const d = planScheduler(before);
    expect(d).toMatchObject({ kind: "intent", action: "review", recipient: reviewer.agent });
    expect(d.kind === "intent" && d.reason.startsWith(HANDBACK_REVIEW_TAG) && d.id.endsWith("1")).toBe(true); // attempt counts rv1
    // still running when handed back: the usual in-flight wait, no second dispatch
    expect(planScheduler({ ...before, intents: [intent("rv1", "submitted")] })).toMatchObject({ kind: "wait", code: "in_flight" });
    // planned after the hand-back: this round's, in-flight dedup kept
    const after = { ...snapshot(review(22), handback(25), plan(26, "rv2")), intents: [intent("rv2", "done")] };
    expect(planScheduler(after)).toMatchObject({ kind: "wait", code: "in_flight" });
  });

  test("a legacy hand-written verdict (no structured head / session / findings) older than the hand-back: dispatch, not review_invalid", () => {
    const legacy = (seq: number) => event(seq, "review", { round: 1, verdict: "pass", p0: 0, p1: 0, p2: 0, path: "reviews/T1-r1/manual.md" }, "agent-pm");
    const d = planScheduler(snapshot(legacy(20), handback(25)));
    expect(d).toMatchObject({ kind: "intent", action: "review", recipient: reviewer.agent });
    expect(d.kind === "intent" && d.reason.startsWith(HANDBACK_REVIEW_TAG)).toBe(true);
    // a structured hand-dispatched verdict by another reviewer is not the card's prior reviewer either: no reviewer_replaced
    const other = event(20, "review", { ...review(20).data, reviewer: "agent-hand", reviewerSessionId: "session-hand" }, "agent-pm");
    expect(planScheduler(snapshot(other, handback(25)))).toMatchObject({ kind: "intent", action: "review", recipient: reviewer.agent });
    // written after the hand-back, or with no hand-back at all: review_invalid as before
    expect(planScheduler(snapshot(handback(18), legacy(20)))).toMatchObject({ kind: "escalate", code: "review_invalid" });
    expect(planScheduler(snapshot(legacy(20)))).toMatchObject({ kind: "escalate", code: "review_invalid" });
  });

  test("strict seq order: a verdict equal to or after the hand-back's seq is this round's", () => {
    const evs = [handback(25)];
    expect([24, 25, 26].map((seq) => reviewBeforeHandback(evs, seq))).toEqual([true, false, false]);
    expect(reviewBeforeHandback([], 1)).toBe(false);
  });
});

describe("shared judgements", () => {
  const session = (state: SchedulerSession["state"]) => ({ taskId: "T1", role: "author", agent: "a", sessionId: "s", family: "claude",
    transport: "tmux", state, createIntentId: "i", createdAt: 1, updatedAt: 1 }) as SchedulerSession;
  test("retired binds nobody; active / retiring still bind", () => {
    expect(liveBinding(session("retired"))).toBeNull();
    expect(liveBinding(null)).toBeNull();
    expect(liveBinding(session("active"))?.state).toBe("active");
    expect(liveBinding(session("retiring"))?.state).toBe("retiring");
  });

  test("a hold is lifted only by a later request of whoever set it", () => {
    const evs = [event(5, "scheduler", { op: "workflow", mode: "manual", hold: "留人工" }, "agent-pm")];
    expect(standingHold(evs)?.seq).toBe(5);
    expect(standingHold(evs, { seq: 6, requestedBy: "agent-pm" })).toBeNull();
    expect(standingHold(evs, { seq: 4, requestedBy: "agent-pm" })?.seq).toBe(5);
    expect(standingHold(evs, { seq: 6, requestedBy: "agent-pm2" })?.seq).toBe(5);
    expect(holdLiftedBy({ seq: 5, actor: "owner" }, { seq: 6, requestedBy: "agent-pm" })).toBe(false);
    expect(holdLiftedBy({ seq: 5, actor: "owner" }, { seq: 6, requestedBy: "owner" })).toBe(true);
    // a later workflow event without hold (`workflow-set manual` again) is no hold at all, as before
    expect(standingHold([...evs, event(7, "scheduler", { op: "workflow", mode: "manual" })])).toBeNull();
  });
});

describe("[验收线 5] verifyAfterResolve without configuration", () => {
  test("is a known high-risk (permission) key whose effective mode is observe", () => {
    expect(RECOVERY_KEYS).toContain(VERIFY_AFTER_RESOLVE);
    expect(highRiskRecoveryKey(VERIFY_AFTER_RESOLVE)).toBe(true);
    rmSync(RECOVERY_POLICY_PATH, { force: true });
    expect(recoveryPolicy("p", VERIFY_AFTER_RESOLVE).mode).toBe("observe");
    expect(verifyAfterResolveMode("p")).toBe("observe");
  });
});
