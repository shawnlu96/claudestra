/**
 * i28-PLANSNAP1: the planner is a pure interpreter of its snapshot. The project's repository is a snapshot fact (`projectRepo`,
 * filled by autoSnapshot for merge-stage cards only); the planner never reads scheduler.json or git, so replaying one snapshot
 * gives one decision whatever the live lookup says. Reviewer's probe shape (i28-SECPOOL4 r3 planner-io).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask } from "../src/lib/ledger-store.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { mergedCard } from "./deploy-test-kit.js";

const HEAD = "a".repeat(40);
const PUBLIC_REPO = "shawnlu96/claudestra", PRIVATE_REPO = "floka-ai/cloud";
const PRIVATE = `https://github.com/${PRIVATE_REPO}/pull/12`, PUBLIC = `https://github.com/${PUBLIC_REPO}/pull/1027`;
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text: "", dedupKey: null });
const task = (stage: Stage, pr: string | null): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "T", kind: "code", stage, stageBefore: null, round: 1,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
});
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "PM 接手", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const sentReview: SchedulerIntent = { id: "review-r1", taskId: "T1", project: "p", node: "adversarial_review", action: "review",
  recipient: reviewer.agent, causalSeq: 14, eventSeq: 15, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done",
  attempts: 0, receipt: null, reason: "x", createdAt: 14, updatedAt: 14 };
/** A merge-stage card whose passing review is proved: the planner turns it into a merge intent. */
const mergeReady = (pr: string | null, extra: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
  task: task("merge", pr), workflow: { ...workflow }, intents: [sentReview], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"],
  events: [event(1, "task", { op: "new" }), event(11, "stage", { from: "build", to: "review", round: 1 }), event(19, "deliver", { round: 1, headSHA: HEAD }),
    event(20, "review", { round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: reviewer.family,
      path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0 }),
    event(31, "stage", { from: "review", to: "merge", round: 1 })],
  heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [{ intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 16 }],
  uiGate: { state: "none" }, screenshotsDigest: null, ...extra,
});

afterEach(() => setForeignRepoLookupForTest({ project: null, origin: null }));

describe("i28-PLANSNAP1 planner purity", () => {
  test("probe: one snapshot planned under a public and a private lookup gives the same decision", () => {
    for (const snap of [mergeReady(PRIVATE), mergeReady(PRIVATE, { projectRepo: PUBLIC_REPO }), mergeReady(PUBLIC, { projectRepo: PUBLIC_REPO }),
      mergeReady(PRIVATE, { projectRepo: null })]) {
      setForeignRepoLookupForTest({ project: () => PUBLIC_REPO });
      const underPublic = planScheduler(structuredClone(snap));
      setForeignRepoLookupForTest({ project: () => PRIVATE_REPO });
      const underPrivate = planScheduler(structuredClone(snap));
      expect(underPrivate).toEqual(underPublic);
    }
  });

  test("snapshot projectRepo public, card private: escalate foreign_repo naming the card's repository", () => {
    setForeignRepoLookupForTest({ project: () => PRIVATE_REPO }); // the live lookup is never consulted
    const d = planScheduler(mergeReady(PRIVATE, { projectRepo: PUBLIC_REPO }));
    expect(d).toMatchObject({ kind: "escalate", code: "foreign_repo" });
    expect(d.kind === "escalate" && d.reason).toContain(PRIVATE_REPO);
  });

  test("projectRepo absent or null: the merge intent a public card got before", () => {
    setForeignRepoLookupForTest({ project: () => PUBLIC_REPO });
    const before = planScheduler(mergeReady(PUBLIC, { projectRepo: PUBLIC_REPO }));
    expect(before).toMatchObject({ kind: "intent", action: "merge" });
    expect(planScheduler(mergeReady(PRIVATE))).toEqual(before);
    expect(planScheduler(mergeReady(PRIVATE, { projectRepo: null }))).toEqual(before);
  });
});

describe("i28-PLANSNAP1 autoSnapshot fills projectRepo for merge-stage cards only", () => {
  test("merge stage: the lookup's repository, lowercased; unknown is null", () => {
    const c = mergedCard();
    try {
      setForeignRepoLookupForTest({ project: (p) => (p === "p" ? "ShawnLu96/Claudestra" : null) });
      expect(autoSnapshot(c.db, getTask(c.db, "T9")!, { registry: [], maxWorkers: 2 }).projectRepo).toBe(PUBLIC_REPO);
      setForeignRepoLookupForTest({ project: () => null });
      const s = autoSnapshot(c.db, getTask(c.db, "T9")!, { registry: [], maxWorkers: 2 });
      expect("projectRepo" in s && s.projectRepo).toBeNull();
    } finally { c.close(); }
  });

  test("any other stage: the field is absent and the lookup is never run", () => {
    const c = mergedCard();
    try {
      let reads = 0;
      setForeignRepoLookupForTest({ project: () => { reads++; return PUBLIC_REPO; } });
      for (const stage of ["build", "review", "fix", "live", "done"] as const) {
        c.db.query("UPDATE tasks SET stage=? WHERE id='T9'").run(stage);
        expect("projectRepo" in autoSnapshot(c.db, getTask(c.db, "T9")!, { registry: [], maxWorkers: 2 })).toBe(false);
      }
      expect(reads).toBe(0);
    } finally { c.close(); }
  });
});
