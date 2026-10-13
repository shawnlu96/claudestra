/**
 * UIRES2 · the shared review source predicate (review-source-proof.ts) on pure planner snapshots: formal dispatch receipt plus the
 * card's reviewer session, PM-adopted and center sources pass; every broken receipt / session / boundary is refused. Each case is
 * held to the planner's own decision on the same snapshot: merge stage merge_review_unproven exactly when unsourced, review stage
 * review_unsolicited (no receipt) before the review_transition wait before reviewer_mismatch (receipt, wrong session).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { reviewDispatchProof, reviewerSessionMatches, reviewSourced } from "../src/lib/review-source-proof.js";
import { configureCenterFactRoute } from "../src/lib/scheduler-center-facts.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts, type ReviewFacts } from "../src/lib/scheduler-review.js";
import { CENTER_FACT_KEY, CENTER_FACT_SOURCE } from "../src/lib/shared-ledger-v2-projection-facts.js";
import { PROJECTION_ACTOR } from "../src/lib/shared-ledger-v2-write-gate.js";

const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}, actor = "agent-author"): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor, project: "p", target: "T1", text: "", dedupKey: null });
const task = (stage: Stage): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "UIRES2", kind: "code", stage, stageBefore: null, round: 1,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow = (template: TaskWorkflow["template"] = "code"): TaskWorkflow => ({
  taskId: "T1", project: "p", template, templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1,
});
const review = (seq: number, over: Record<string, unknown> = {}, actor?: string): LedgerEvent => event(seq, "review", {
  round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: reviewer.family,
  path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0, ...over }, actor);
/** The formal order: placed at #15 after the review entry #11, acknowledged by the reviewer session at #16, verdict at #20. */
const order = (over: Partial<SchedulerIntent> = {}): SchedulerIntent => ({
  id: "review-r1", taskId: "T1", project: "p", node: "adversarial_review", action: "review", recipient: reviewer.agent, causalSeq: 14,
  eventSeq: 15, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done", attempts: 0, receipt: null, reason: "x",
  createdAt: 14, updatedAt: 14, ...over,
});
const receipt = (over: Record<string, unknown> = {}) =>
  ({ intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 16, ...over });
const snapshot = (stage: Stage = "review"): PlannerSnapshot => ({
  task: task(stage), workflow: workflow(), author, reviewer, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  events: [event(1, "task", { op: "new" }), event(11, "stage", { from: "build", to: "review", round: 1 }), review(20)],
  intents: [order()], reviewDispatches: [receipt()], blockedBy: [], queueFrozen: false,
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", uiGate: { state: "none" }, screenshotsDigest: null,
});
const facts = (s: PlannerSnapshot): ReviewFacts => {
  const read = currentReviewFacts(s.task, s.events);
  if (read.kind !== "facts") throw new Error(`no facts: ${read.kind}`);
  return read.facts;
};
/** The merge gate's reading of the same facts must agree with the predicate. */
const mergeAgrees = (s: PlannerSnapshot) => {
  const merge = { ...s, task: { ...s.task, stage: "merge" as Stage } };
  const unproven = planScheduler(merge);
  expect(unproven.kind === "escalate" && unproven.code === "merge_review_unproven").toBe(!reviewSourced(merge, facts(merge)));
};

afterEach(() => configureCenterFactRoute(null));

describe("[验收线 1] formal sources pass, on both readers", () => {
  test("dispatch receipt + matching cross-model reviewer session", () => {
    const s = snapshot();
    expect([reviewDispatchProof(s, facts(s)), reviewerSessionMatches(s, facts(s)), reviewSourced(s, facts(s))]).toEqual([true, true, true]);
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    mergeAgrees(s);
    for (const status of ["submitted", "done"] as const) {
      const t = { ...snapshot(), intents: [order({ status })] };
      expect(reviewSourced(t, facts(t))).toBe(true);
    }
  });

  test("PM-adopted manual verdict stands without a home receipt or session", () => {
    const s = { ...snapshot(), intents: [], reviewDispatches: [], reviewer: null,
      adoptedSource: { ok: true as const, ref: { reviewSeq: 20, reviewer: reviewer.agent, sessionId: reviewer.sessionId, family: reviewer.family } } };
    expect([reviewDispatchProof(s, facts(s)), reviewerSessionMatches(s, facts(s)), reviewSourced(s, facts(s))]).toEqual([false, false, true]);
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    mergeAgrees(s);
    const off = { ...s, adoptedSource: { ...s.adoptedSource, ref: { ...s.adoptedSource.ref, reviewSeq: 19 } } };
    expect(reviewSourced(off, facts(off))).toBe(false);
    mergeAgrees(off);
  });

  test("a center-projected review of a central card stands; the same event off route does not", () => {
    const center = { ...review(20, { source: CENTER_FACT_SOURCE, evidenceDigest: "dg" }, PROJECTION_ACTOR), dedupKey: `${CENTER_FACT_KEY}T1:r1` };
    const s = { ...snapshot(), intents: [], reviewDispatches: [], reviewer: null,
      events: [...snapshot().events.slice(0, 2), event(18, "task", { op: "center-projection", centerReviewDigest: "dg" }, PROJECTION_ACTOR), center] };
    expect(reviewSourced(s, facts(s))).toBe(false);
    mergeAgrees(s);
    configureCenterFactRoute((id) => id === "T1");
    expect(reviewSourced(s, facts(s))).toBe(true);
    mergeAgrees(s);
  });
});

describe("[验收线 1] broken receipts are refused: review_unsolicited at review, merge_review_unproven at merge", () => {
  const cases: [string, (s: PlannerSnapshot) => PlannerSnapshot][] = [
    ["no receipt", (s) => ({ ...s, reviewDispatches: [] })],
    ["no order", (s) => ({ ...s, intents: [] })],
    ["receipt from another session", (s) => ({ ...s, reviewDispatches: [receipt({ reviewerSessionId: "other" })] })],
    ["receipt for another order", (s) => ({ ...s, reviewDispatches: [receipt({ intentId: "review-x" })] })],
    ["order placed at the stage entry seq", (s) => ({ ...s, intents: [order({ eventSeq: 11 })], reviewDispatches: [receipt({ ackSeq: 12 })] })],
    ["order placed at the verdict seq", (s) => ({ ...s, intents: [order({ eventSeq: 20 })] })],
    ["ack at the order seq", (s) => ({ ...s, reviewDispatches: [receipt({ ackSeq: 15 })] })],
    ["ack at the verdict seq", (s) => ({ ...s, reviewDispatches: [receipt({ ackSeq: 20 })] })],
    ["order at the reviewer swap seq", (s) => ({ ...s, events: [...s.events.slice(0, 2), event(15, "scheduler", { op: "reviewer_swap" }), review(20)] })],
    ["order before the reviewer swap", (s) => ({ ...s, events: [...s.events.slice(0, 2), event(17, "scheduler", { op: "reviewer_swap" }), review(20)] })],
    ["order after a swap on an old specRev", (s) => ({ ...s, task: { ...s.task, specRev: 2 }, workflow: { ...s.workflow!, specRev: 2 },
      events: [...s.events.slice(0, 2), event(13, "scheduler", { op: "reviewer_swap" }), review(20)] })],
    ["order for another head", (s) => ({ ...s, intents: [order({ head: OTHER })] })],
    ["receipt for another head", (s) => ({ ...s, reviewDispatches: [receipt({ head: OTHER })] })],
    ["receipt for another round", (s) => ({ ...s, reviewDispatches: [receipt({ round: 2 })] })],
    ["order to another recipient", (s) => ({ ...s, intents: [order({ recipient: "agent-else" })] })],
    ["receipt by another reviewer", (s) => ({ ...s, reviewDispatches: [receipt({ reviewer: "agent-else" })] })],
    ["order still pending", (s) => ({ ...s, intents: [order({ status: "pending" })] })],
    ["order cancelled", (s) => ({ ...s, intents: [order({ status: "cancelled" })] })],
    ["order of another node", (s) => ({ ...s, intents: [order({ node: "fix" })] })],
  ];
  for (const [name, make] of cases) test(name, () => {
    const s = make(snapshot());
    expect(reviewDispatchProof(s, facts(s))).toBe(false);
    expect(reviewSourced(s, facts(s))).toBe(false);
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    mergeAgrees(s);
  });

  test("a swap before a current-specRev order is the formal swap epoch, not a refusal", () => {
    const s = { ...snapshot(), events: [...snapshot().events.slice(0, 2), event(13, "scheduler", { op: "reviewer_swap" }), review(20)] };
    expect(reviewSourced(s, facts(s))).toBe(true);
    mergeAgrees(s);
  });
});

describe("[验收线 1] receipt holds but the session is wrong: reviewer_mismatch, after the transition wait", () => {
  const cases: [string, (s: PlannerSnapshot) => PlannerSnapshot][] = [
    ["card has no reviewer session", (s) => ({ ...s, reviewer: null })],
    ["card's reviewer session is another one", (s) => ({ ...s, reviewer: { ...reviewer, sessionId: "replacement" } })],
    ["card's reviewer is another agent", (s) => ({ ...s, reviewer: { ...reviewer, agent: "agent-else" } })],
    ["card's reviewer is another family", (s) => ({ ...s, reviewer: { ...reviewer, family: "claude" } })],
    ["same family as the author without exemption", (s) => ({ ...s, workflow: { ...s.workflow!, authorFamily: "codex" } })],
    ["security card, peer reviewer, pool not on", (s) => ({ ...s, workflow: { ...s.workflow!, template: "security" }, reviewer: { ...reviewer, source: "peer_claim" } })],
  ];
  for (const [name, make] of cases) test(name, () => {
    const s = make(snapshot());
    expect(reviewDispatchProof(s, facts(s))).toBe(true);
    expect(reviewerSessionMatches(s, facts(s))).toBe(false);
    expect(reviewSourced(s, facts(s))).toBe(false);
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "reviewer_mismatch" });
    mergeAgrees(s);
    // an unfinished follow-up of the verdict is waited on before the session is judged; an unsolicited verdict is not
    const pendingStage = order({ id: "stage-1", action: "stage", node: "adversarial_review", causalSeq: 20, eventSeq: 21, status: "pending", recipient: null });
    expect(planScheduler({ ...s, intents: [...s.intents, pendingStage] })).toMatchObject({ kind: "wait", code: "review_transition" });
    expect(planScheduler({ ...s, intents: [...s.intents, pendingStage], reviewDispatches: [] })).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
  });

  test("security card with a local reviewer, or the pool on, passes", () => {
    const local = { ...snapshot(), workflow: workflow("security") };
    expect(reviewSourced(local, facts(local))).toBe(true);
    const pool = { ...snapshot(), workflow: workflow("security"), reviewer: { ...reviewer, source: "peer_claim" as const }, securityPool: "on" as const };
    expect(reviewSourced(pool, facts(pool))).toBe(true);
    mergeAgrees(local);
  });
});
