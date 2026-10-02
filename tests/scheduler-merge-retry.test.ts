/** i28-MR1：被取消的合并意图经 PM merge_resolve（failed / cancelled）+ workflow_resume 后，planner 自己重试一次合并。 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { BOUNCE_LIMIT_REASON } from "../src/lib/scheduler-merge-conflict.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";

const HEAD = "a".repeat(40), CARRIED = "c".repeat(40), OTHER = "b".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}, actor = "agent-author"): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor, project: "p", target: "T1", text: "", dedupKey: null });
const task = (headSHA = HEAD): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "MR1", kind: "code", stage: "merge", stageBefore: null, round: 1,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const intent = (id: string, node: string, action: SchedulerIntent["action"], status: SchedulerIntent["status"], seq: number,
  extra: Partial<SchedulerIntent> = {}): SchedulerIntent => ({
  id, taskId: "T1", project: "p", node, action, recipient: null, causalSeq: seq, eventSeq: seq + 1, taskRev: 1, specRev: 1, head: HEAD,
  templateVersion: 2, status, attempts: 0, receipt: null, reason: "x", createdAt: seq, updatedAt: seq, ...extra,
});
const MERGE_ENTRY = 31;
const A0 = `t68:s${MERGE_ENTRY}:r1:merge_deploy:a0`;
const passedReview: LedgerEvent[] = [
  event(1, "task", { op: "new" }), event(11, "stage", { from: "build", to: "review", round: 1 }),
  event(19, "deliver", { round: 1, headSHA: HEAD }),
  event(20, "review", { round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: "codex",
    path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0 }),
  event(MERGE_ENTRY, "stage", { from: "review", to: "merge", round: 1 }),
];
const resolve = (seq: number, intentId: string, outcome: string): LedgerEvent =>
  event(seq, "scheduler", { op: "merge_resolve", intentId, from: "unknown", outcome, receipt: "PR OPEN, mergedAt=null", manual: true }, "agent-pm");
const resume = (seq: number): LedgerEvent => event(seq, "scheduler", { op: "workflow_resume", from: "manual", manual: true }, "agent-pm");
const snap = (events: LedgerEvent[], merges: SchedulerIntent[], headSHA = HEAD): PlannerSnapshot => ({
  task: task(headSHA), workflow, events: [...passedReview, ...events],
  intents: [{ ...intent("review-r1", "adversarial_review", "review", "done", 14), eventSeq: 15, recipient: reviewer.agent }, ...merges],
  blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [], workerCount: 0, maxWorkers: 2,
  freeWorkerSlot: "slot:p:0", author, reviewer, uiGate: { state: "none" }, screenshotsDigest: null,
  reviewDispatches: [{ intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 16 }],
});
const cancelledA0 = intent(A0, "merge_deploy", "merge", "cancelled", MERGE_ENTRY + 1);

describe("i28-MR1 merge retry after PM resolve + resume", () => {
  test("baseline: a fresh merge stage plans attempt a0", () => {
    expect(planScheduler(snap([], []))).toMatchObject({ kind: "intent", action: "merge", id: A0 });
  });

  test("[验收线 1] cancelled → PM merge_resolve failed → workflow_resume: a new merge intent on the card head", () => {
    for (const outcome of ["failed", "cancelled"]) {
      const s = snap([resolve(40, A0, outcome), resume(41)], [cancelledA0]);
      const d = planScheduler(s);
      expect(d).toMatchObject({ kind: "intent", action: "merge", node: "merge_deploy", id: `t68:s${MERGE_ENTRY}:r1:merge_deploy:a1` });
      if (d.kind === "intent") expect(d.id).not.toBe(A0);
      // The write side pins the new intent's head (= scheduler_merges.reviewedHead) to task.headSHA: it is the head the cancelled one reviewed.
      expect(s.task.headSHA).toBe(cancelledA0.head!);
    }
  });

  test("[验收线 2] cancelled without resolve, or resolve without resume → merge_retry_requires_pm", () => {
    expect(planScheduler(snap([], [cancelledA0]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    expect(planScheduler(snap([resolve(40, A0, "failed")], [cancelledA0]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    // A resume before the resolve does not count; nor does a resolve for another intent, or one the scheduler wrote.
    expect(planScheduler(snap([resume(39), resolve(40, A0, "failed")], [cancelledA0]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    expect(planScheduler(snap([resolve(40, "other", "failed"), resume(41)], [cancelledA0]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    const bySched = { ...resolve(40, A0, "failed"), actor: "scheduler" };
    expect(planScheduler(snap([bySched, resume(41)], [cancelledA0]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
  });

  test("[验收线 3] resolve outcome=done → no new merge intent", () => {
    const d = planScheduler(snap([resolve(40, A0, "done"), resume(41)], [cancelledA0]));
    expect(d.kind).not.toBe("intent");
    expect(d).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    expect(mergeRetryReleased(task(), [resolve(40, A0, "done"), resume(41)], cancelledA0)).toBe(false);
  });

  test("[验收线 4] the released retry cancelled again without its own resolve + resume → merge_retry_requires_pm", () => {
    const A1 = `t68:s${MERGE_ENTRY}:r1:merge_deploy:a1`;
    const retry = intent(A1, "merge_deploy", "merge", "cancelled", 42);
    const once = [resolve(40, A0, "failed"), resume(41)];
    expect(planScheduler(snap(once, [cancelledA0, retry]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm", reason: expect.stringContaining(A1) });
    // A second resume alone is not a release either; a fresh resolve for the retry plus a resume is.
    expect(planScheduler(snap([...once, resume(50)], [cancelledA0, retry]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    expect(planScheduler(snap([...once, resolve(50, A1, "failed"), resume(51)], [cancelledA0, retry])))
      .toMatchObject({ kind: "intent", action: "merge", id: `t68:s${MERGE_ENTRY}:r1:merge_deploy:a2` });
  });

  test("[验收线 5] bounce limit wins over a release", () => {
    const bounced = event(35, "scheduler", { op: "merge_conflict", intentId: A0, cause: "conflict", count: 4, escalated: true }, "scheduler");
    expect(planScheduler(snap([bounced, resolve(40, A0, "failed"), resume(41)], [cancelledA0])))
      .toMatchObject({ kind: "escalate", code: "merge_bounce_limit", reason: BOUNCE_LIMIT_REASON });
  });

  test("[规格 4] card head differs from the reviewed head and is not a pure main merge-in → not released", () => {
    const events = [resolve(40, A0, "failed"), resume(41)];
    expect(planScheduler(snap(events, [cancelledA0], OTHER))).toMatchObject({ kind: "escalate" });
    expect(mergeRetryReleased(task(OTHER), events, cancelledA0)).toBe(false);
    // The scheduler's own review carry (pure main merge-in) from the reviewed head to the card head keeps the release.
    const carry = event(36, "scheduler", { op: "review_carry", intentId: A0, from: HEAD, to: CARRIED }, "scheduler");
    expect(mergeRetryReleased(task(CARRIED), [carry, ...events], cancelledA0)).toBe(true);
    // A carry not written by the scheduler, or for another intent, does not launder a head.
    expect(mergeRetryReleased(task(CARRIED), [{ ...carry, actor: "agent-pm" }, ...events], cancelledA0)).toBe(false);
    expect(mergeRetryReleased(task(CARRIED), [{ ...carry, data: { ...carry.data, intentId: "x" } }, ...events], cancelledA0)).toBe(false);
  });
});
