import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text: "", dedupKey: null });
const entry = (stage: Stage, round = 1): LedgerEvent => event(10 + round, "stage", { from: "build", to: stage, round });
const task = (stage: Stage = "spec", round = 0): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "T68", kind: "code", stage, stageBefore: null, round,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow = (template: TaskWorkflow["template"] = "code"): TaskWorkflow => ({
  taskId: "T1", project: "p", template, templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1,
});
const snapshot = (stage: Stage = "spec", round = 0, template: TaskWorkflow["template"] = "code"): PlannerSnapshot => ({
  task: task(stage, round), workflow: workflow(template), events: [event(1, "task", { op: "new" }), ...(stage === "spec" ? [] : [entry(stage, round)])],
  intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});
const delivery = (seq: number, round: number): LedgerEvent => event(seq, "deliver", { round, headSHA: HEAD });
const finding = (family: string, severity: "P0" | "P1" | "P2" = "P1") =>
  ({ findingId: `${family}-${severity}`, family, severity, probe: `probe for ${family}` });
const review = (seq: number, round: number, findings: ReturnType<typeof finding>[], verdict: string = "changes"): LedgerEvent =>
  event(seq, "review", { round, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId,
    reviewerFamily: reviewer.family, path: `reviews/T1-r${round}/report.md`, verdict, findings,
    p0: findings.filter((f) => f.severity === "P0").length,
    p1: findings.filter((f) => f.severity === "P1").length,
    p2: findings.filter((f) => f.severity === "P2").length });
const intent = (node: string, action: SchedulerIntent["action"], status: SchedulerIntent["status"], seq: number): SchedulerIntent => ({
  id: `i${seq}`, taskId: "T1", project: "p", node, action, recipient: null, causalSeq: seq,
  eventSeq: seq + 1, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status,
  attempts: 0, receipt: null, reason: "x", createdAt: seq, updatedAt: seq,
});
const sentReview = (round: number, seq: number): SchedulerIntent => ({ ...intent("adversarial_review", "review", "done", seq - 1),
  id: `review-r${round}`, eventSeq: seq, recipient: reviewer.agent });
const proof = (round: number, intentSeq: number) => ({ intentId: `review-r${round}`, round, head: HEAD,
  reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: intentSeq + 1 });

describe("T68 data workflow planner", () => {
  test("two P1 cards at full capacity reuse their own slot instead of deadlocking or claiming a second slot", () => {
    for (const [id, own, other] of [["T1", "slot:p:0", "slot:p:1"], ["T2", "slot:p:1", "slot:p:0"]]) {
      const s = snapshot("fix", 1);
      s.task.id = id;
      s.workflow!.taskId = id;
      s.author = { ...author, taskId: id };
      s.events = [...s.events, delivery(19, 1), review(20, 1, [finding("delivery")]),
        event(25, "stage", { from: "review", to: "fix", round: 1 })];
      s.heldResources = [{ taskId: id, resource: own }, { taskId: id === "T1" ? "T2" : "T1", resource: other }];
      s.workerCount = 2;
      s.freeWorkerSlot = null;
      const decision = planScheduler(s);
      expect(decision).toMatchObject({ kind: "intent", action: "dispatch" });
      if (decision.kind === "intent") expect(decision.resources.filter((r) => r.startsWith("slot:"))).toEqual([own]);
      s.workerCount = 1;
      s.freeWorkerSlot = "slot:p:2";
      const spare = planScheduler(s);
      expect(spare).toMatchObject({ kind: "intent", action: "dispatch" });
      if (spare.kind === "intent") expect(spare.resources.filter((r) => r.startsWith("slot:"))).toEqual([own]);
    }
  });
  test("new card provisions its author, then dispatches once; capacity, dependency and file locks stop new work", () => {
    const s = snapshot();
    s.author = null;
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "author", sessionFamily: "claude" });
    s.intents = [intent("restate", "ensure_session", "done", 1)];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "in_flight" });
    s.author = author;
    s.intents = [intent("restate", "ensure_session", "pending", 1)];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "intent_in_flight" });
    s.intents = [intent("restate", "ensure_session", "done", 1)];
    const planned = planScheduler(s);
    expect(planned).toMatchObject({ kind: "intent", action: "dispatch", recipient: author.agent });
    if (planned.kind === "intent") expect(planned.resources).toContain("src/lib/*.ts");
    s.workerCount = 2;
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "capacity" });
    s.workerCount = 0;
    s.heldResources = [{ taskId: "T2", resource: "src/lib/ledger-store.ts" }];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "resource_busy" });
    s.heldResources = [];
    s.blockedBy = ["T0"];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "dependency" });
    s.blockedBy = [];
    s.queueFrozen = true;
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "queue_frozen" });
  });

  test("restate waits for PM's matching spec approval; reviewer must be a separate cross-family session", () => {
    const s = snapshot("restate", 0);
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "pm_restate" });
    s.events = [...s.events, event(30, "decision", { op: "restate_approved", specRev: 1 })];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "build" });
    s.task = task("review", 1);
    s.events = [event(1, "task", { op: "new" }), entry("review", 1)];
    s.reviewer = null;
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer", sessionFamily: "codex" });
    s.reviewer = { ...reviewer, family: "claude" };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "reviewer_independence" });
    s.reviewer = reviewer;
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: reviewer.agent, reviewMode: "adversarial" });
    s.events = [...s.events, review(20, 1, [], "pass"), entry("review", 2)];
    s.task = task("review", 2);
    s.reviewer = { ...reviewer, sessionId: "replacement" };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "reviewer_replaced" });
  });

  test("P1 auto-fixes with original probes; second same family warns, third stops with history", () => {
    const s = snapshot("review", 1);
    s.events = [...s.events, delivery(19, 1), review(20, 1, [finding("delivery")])];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    s.intents = [sentReview(1, 15)];
    s.reviewDispatches = [proof(1, 15)];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix",
      workOrder: { findings: [finding("delivery")], fallbackWarning: null } });
    s.task = task("review", 2);
    s.events = [...s.events, entry("review", 2), delivery(29, 2), review(30, 2, [finding("delivery")])];
    s.intents = [...s.intents, sentReview(2, 25)];
    s.reviewDispatches = [...s.reviewDispatches, proof(2, 25)];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", workOrder: { fallbackWarning: "再不行退到：收窄为只报错" } });
    s.task = task("fix", 2);
    s.events = [...s.events, entry("fix", 2)];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "dispatch",
      workOrder: { reportPath: "reviews/T1-r2/report.md", fallbackWarning: "再不行退到：收窄为只报错" } });
    s.task = task("review", 3);
    s.events = [...s.events, entry("review", 3), delivery(39, 3), review(40, 3, [finding("delivery")])];
    s.intents = [...s.intents, sentReview(3, 35)];
    s.reviewDispatches = [...s.reviewDispatches, proof(3, 35)];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "three_p1_rounds", reviewSeq: 40 });
    s.events = s.events.map((e) => e.kind === "review" && e.data.round === 2 ? review(30, 2, [finding("different")]) : e);
    expect(planScheduler(s)).toMatchObject({ kind: "intent", workOrder: { fallbackWarning: "再不行退到：收窄为只报错" } });
  });

  test("P2-only review proceeds without re-review; UI approval is bound to head and spec", () => {
    const s = snapshot("review", 1, "ui");
    const digest = "d".repeat(64);
    s.screenshotsDigest = digest;
    s.events = [...s.events, delivery(19, 1), review(20, 1, [finding("layout", "P2")], "pass")];
    s.intents = [sentReview(1, 15)];
    s.reviewDispatches = [proof(1, 15)];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "ask", askBind: { task: "T1", head: HEAD, specRev: 1, screenshotsDigest: digest } });
    s.uiGate = { state: "open", head: HEAD, specRev: 1, screenshotsDigest: digest };
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "owner_screenshot" });
    s.uiGate = { state: "approved", head: HEAD, specRev: 1, screenshotsDigest: digest };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "ui_unverified" });
    s.uiGate = { state: "approved", head: HEAD, specRev: 1, screenshotsDigest: digest, ownerVerified: true };
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge", pmDiffNotice: true });
    s.intents = [...s.intents, { ...intent("adversarial_review", "ask", "done", 21), id: "screenshot-ask" }];
    s.uiGate = { state: "none" };
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "owner_screenshot" });
    s.uiGate = { state: "approved", head: HEAD, specRev: 1, screenshotsDigest: digest, ownerVerified: true };
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    s.uiGate = { state: "open", head: HEAD, specRev: 1, screenshotsDigest: digest };
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "owner_screenshot" });
    s.uiGate = { state: "rejected", head: HEAD, specRev: 1, screenshotsDigest: digest };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "ui_rejected" });
    s.uiGate = { state: "approved", head: HEAD, specRev: 1, screenshotsDigest: digest, ownerVerified: true };
    s.screenshotsDigest = "e".repeat(64);
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "ui_stale" });
    s.screenshotsDigest = digest;
    s.uiGate = { state: "approved", head: "b".repeat(40), specRev: 1 };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "ui_stale" });
  });

  test("a previous round's dispatch cannot authorize this round; corrupt old P1 evidence stops streak counting", () => {
    const s = snapshot("review", 2);
    s.events = [event(1, "task", { op: "new" }), event(11, "stage", { to: "review", round: 1 }),
      delivery(19, 1), review(20, 1, [finding("delivery")]), event(22, "stage", { to: "review", round: 2 }),
      delivery(29, 2), review(30, 2, [finding("delivery")])];
    s.intents = [sentReview(1, 15)];
    s.reviewDispatches = [proof(1, 15)];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    s.intents = [...s.intents, sentReview(2, 25)];
    s.reviewDispatches = [...s.reviewDispatches, proof(2, 25)];
    s.events = s.events.map((e) => e.kind === "review" && e.data.round === 1 ? { ...e, data: { ...e.data, p1: 0 } } : e);
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "review_history" });
  });

  test("stale head, unverified reviewer and missing findings stop; merge intent leaves CI to the queue adapter", () => {
    const s = snapshot("review", 1, "security");
    s.events = [...s.events, delivery(19, 1), review(20, 1, [], "pass")];
    s.intents = [sentReview(1, 15)];
    s.reviewDispatches = [proof(1, 15)];
    s.reviewer = { ...reviewer, source: "peer_claim" };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "reviewer_mismatch" });
    s.reviewer = reviewer;
    s.task = { ...s.task, headSHA: "b".repeat(40) };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "review_invalid" });
    s.task = task("review", 1);
    s.events = [...s.events.slice(0, -1), event(20, "review", { round: 1, head: HEAD, verdict: "pass" })];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "review_invalid" });
    s.task = task("merge", 1);
    s.events = [event(1, "task", { op: "new" }), entry("merge", 1)];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "merge_review_missing" });
    s.events = [event(1, "task", { op: "new" }), entry("review", 1), delivery(19, 1), review(20, 1, [], "pass"),
      event(31, "stage", { from: "review", to: "merge", round: 1 })];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "merge" });
    s.intents = [...s.intents, intent("merge_deploy", "merge", "cancelled", 32)];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    s.intents = s.intents.slice(0, -1);
    s.queueFrozen = true;
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "queue_frozen" });
  });

  test("renaming every P1 family cannot evade the fourth-round hard stop", () => {
    const s = snapshot("review", 1);
    s.events = [event(1, "task", { op: "new" })];
    const names = ["auth", "Auth", "auth-gate", "permission"];
    for (let round = 1; round <= names.length; round++) {
      const base = round * 100;
      s.task = task("review", round);
      s.events = [...s.events, event(base, "stage", { to: "review", round }), delivery(base + 9, round),
        review(base + 20, round, [finding(names[round - 1])])];
      s.intents = [...s.intents, sentReview(round, base + 5)];
      s.reviewDispatches = [...s.reviewDispatches, proof(round, base + 5)];
      const result = planScheduler(s);
      expect(result.kind).toBe(round === 4 ? "escalate" : "intent");
      if (round === 4) expect(result).toMatchObject({ kind: "escalate", code: "four_p1_rounds" });
    }
  });

  test("a persistent findingId reaches the third-round gate even when family names change", () => {
    const s = snapshot("review", 1);
    s.events = [event(1, "task", { op: "new" })];
    for (let round = 1; round <= 3; round++) {
      const base = round * 100;
      s.task = task("review", round);
      s.events = [...s.events, event(base, "stage", { to: "review", round }), delivery(base + 9, round),
        review(base + 20, round, [{ ...finding(`renamed-${round}`), findingId: "stable-auth" }])];
      s.intents = [...s.intents, sentReview(round, base + 5)];
      s.reviewDispatches = [...s.reviewDispatches, proof(round, base + 5)];
    }
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "three_p1_rounds" });
  });

  test("a new spec revision starts a fresh P1 escalation count", () => {
    const s = snapshot("review", 1);
    s.events = [event(1, "task", { op: "new" })];
    for (let round = 1; round <= 4; round++) {
      const base = round * 100;
      s.task = { ...task("review", round), specRev: round === 4 ? 2 : 1 };
      s.workflow = { ...workflow(), specRev: s.task.specRev };
      if (round === 4) s.events = [...s.events, event(base - 2, "scheduler", { op: "workflow", specRev: 2 })];
      s.events = [...s.events, event(base, "stage", { to: "review", round }), delivery(base + 9, round),
        review(base + 20, round, [finding("same")])];
      s.intents = [...s.intents, sentReview(round, base + 5)];
      s.reviewDispatches = [...s.reviewDispatches, proof(round, base + 5)];
    }
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix",
      workOrder: { fallbackWarning: null } });
  });

  test("a card in review keeps its file lease so a second card waits for the hot file", () => {
    const s = snapshot("build", 1);
    s.task = { ...task("build", 1), id: "T2" };
    s.author = { ...author, taskId: "T2" };
    s.workflow = { ...workflow(), taskId: "T2" };
    s.fileGlobs = ["src/bridge.ts"];
    s.heldResources = [{ taskId: "T1", resource: "src/bridge.ts" }];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "resource_busy" });
  });

  test("merge stage rechecks reviewed head and the owner screenshot binding", () => {
    const s = snapshot("merge", 1, "ui");
    const digest = "d".repeat(64);
    s.screenshotsDigest = digest;
    s.events = [event(1, "task", { op: "new" }), entry("review", 1), delivery(19, 1), review(20, 1, [], "pass"),
      event(31, "stage", { from: "review", to: "merge", round: 1 })];
    s.intents = [sentReview(1, 15)];
    s.reviewDispatches = [proof(1, 15)];
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "merge_ui_unapproved" });
    s.uiGate = { state: "approved", ownerVerified: true, head: HEAD, specRev: 1, screenshotsDigest: digest };
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "merge" });
    s.task = { ...s.task, headSHA: "f".repeat(40) };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "merge_review_missing" });
    s.task = task("merge", 1);
    s.uiGate = { state: "approved", ownerVerified: true, head: HEAD, specRev: 2, screenshotsDigest: digest };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "merge_ui_unapproved" });
  });
});
