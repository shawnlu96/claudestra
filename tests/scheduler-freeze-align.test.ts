import { describe, expect, test } from "bun:test";
import { INTENT_ACTIONS, type SchedulerIntent, type TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { frozenBlocks } from "../src/lib/ledger-scheduler-write.js";
import { STAGES, type LedgerEvent, type LedgerTask, type Stage } from "../src/lib/ledger-stages.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { autoFixture, H1, P1, toBuild } from "./scheduler-auto-helpers.js";

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text: "", dedupKey: null });
const task = (stage: Stage, round: number): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "M10", kind: "code", stage, stageBefore: null, round,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow = (): TaskWorkflow => ({ taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 });
const snapshot = (stage: Stage, round = 1, frozen = true): PlannerSnapshot => ({
  task: task(stage, round), workflow: workflow(), events: [event(1, "task", { op: "new" }), ...(stage === "spec" ? [] : [event(11, "stage", { from: "build", to: stage, round })])],
  intents: [], blockedBy: [], queueFrozen: frozen, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});
const review = (seq: number, verdict: string, findings: object[]): LedgerEvent => event(seq, "review", { round: 1, head: HEAD,
  reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: reviewer.family, path: "reviews/T1-r1/report.md", verdict, findings,
  p0: 0, p1: findings.length, p2: 0 });
const sentReview: SchedulerIntent = { id: "review-r1", taskId: "T1", project: "p", node: "adversarial_review", action: "review",
  recipient: reviewer.agent, causalSeq: 15, eventSeq: 16, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done",
  attempts: 0, receipt: null, reason: "x", createdAt: 15, updatedAt: 15 };
const proof = { intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 17 };

/** Frozen snapshots on which the planner still has work; each must produce an intent the write entry accepts. */
const FROZEN_WORK: [string, () => PlannerSnapshot, SchedulerIntent["action"]][] = [
  ["review stage dispatches its reviewer", () => { const s = snapshot("review"); s.events.push(event(12, "deliver", { round: 1, headSHA: HEAD })); return s; }, "review"],
  ["review stage provisions a missing reviewer", () => { const s = snapshot("review"); s.reviewer = null; s.events.push(event(12, "deliver", { round: 1, headSHA: HEAD })); return s; }, "ensure_session"],
  ["changes verdict moves review → fix", () => {
    const s = snapshot("review");
    s.events.push(event(12, "deliver", { round: 1, headSHA: HEAD }), review(20, "changes", [{ findingId: "x-P1", family: "x", severity: "P1", probe: "p" }]));
    s.intents = [sentReview]; s.reviewDispatches = [proof];
    return s;
  }, "stage"],
  ["pass verdict moves review → merge", () => {
    const s = snapshot("review");
    s.events.push(event(12, "deliver", { round: 1, headSHA: HEAD }), review(20, "pass", []));
    s.intents = [sentReview]; s.reviewDispatches = [proof];
    return s;
  }, "stage"],
  ["approved restate moves restate → build", () => {
    const s = snapshot("restate", 0);
    s.events.push(event(30, "decision", { op: "restate_approved", specRev: 1 }));
    return s;
  }, "stage"],
  ["live card is verified", () => snapshot("live"), "verify"],
];

describe("i28-M10 frozen queue: write entry accepts exactly what the planner still plans", () => {
  test("stage × action matrix: blocked ⇔ the planner waits on the freeze for that stage, or the action is merge", () => {
    for (const stage of STAGES) {
      const plannerFreezes = (() => { const d = planScheduler(snapshot(stage)); return d.kind === "wait" && d.code === "queue_frozen"; })();
      for (const action of INTENT_ACTIONS) {
        expect({ stage, action, blocked: frozenBlocks(stage, action) }).toEqual({ stage, action, blocked: plannerFreezes || action === "merge" });
      }
    }
    for (const stage of ["spec", "build", "fix"] as const) expect(frozenBlocks(stage, "dispatch")).toBe(true);
    for (const stage of STAGES) expect(frozenBlocks(stage, "merge")).toBe(true);
    expect(frozenBlocks("review", "review")).toBe(false);
  });

  test("no combination where the planner plans while frozen and the write entry refuses", () => {
    for (const [name, make, action] of FROZEN_WORK) {
      const s = make();
      const d = planScheduler(s);
      expect({ name, kind: d.kind, action: d.kind === "intent" ? d.action : null }).toEqual({ name, kind: "intent", action });
      if (d.kind === "intent") expect({ name, blocked: frozenBlocks(s.task.stage, d.action) }).toEqual({ name, blocked: false });
      s.queueFrozen = false;
      expect(planScheduler(s)).toMatchObject({ kind: "intent", action }); // the freeze changes nothing for these
    }
  });
});

describe("i28-M10 frozen queue on the real ledger", () => {
  test("a frozen project still dispatches its review and applies the verdict, but starts no fix", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick(); // write order
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      expect((await f.cli("pm", "freeze", "--reason", "拦合并", "--project", "p")).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
      expect(f.sent.at(-1)).toMatchObject({ agent: "agent-rv-t1" });
      expect((await f.review("changes", H1, [P1])).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      const before = f.sent.length;
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "项目队列已冻结，不派新活" });
      expect(f.sent).toHaveLength(before);
      expect((await f.cli("pm", "unfreeze", "--project", "p")).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
    } finally { f.close(); }
  });

  test("the write entry itself refuses new work and merge while frozen, with the frozen reason", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      expect((await f.cli("pm", "freeze", "--reason", "拦合并", "--project", "p")).ok).toBe(true);
      const seq = String((f.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s);
      const rev = String(f.task().rev);
      const plan = (action: string, node: string) => f.cli("scheduler", "scheduler-plan", "T1", "--id", `x:${action}`, "--rev", rev, "--workflow-rev", "1",
        "--seq", seq, "--node", node, "--action", action, "--reason", "test", "--resources", "slot:p:0");
      for (const [action, node] of [["dispatch", "write"], ["merge", "merge_deploy"]]) {
        expect(await plan(action, node)).toMatchObject({ ok: false, code: "conflict", error: "项目合并队列已冻结" });
      }
    } finally { f.close(); }
  });
});
