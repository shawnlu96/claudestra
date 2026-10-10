/** i28-SECPOOL4: repository facts, the planner gate, the marked inspect refusal and the foreign_repo manual reason. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { cardRepo, foreignRepoOf, githubRepoOf, isForeignRepoError, projectRepo, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { MANUAL_REASON_CODES, parseManualReason } from "../src/lib/manual-reason.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const HEAD = "a".repeat(40);
const PUBLIC = "https://github.com/shawnlu96/claudestra/pull/1027", PRIVATE = "https://github.com/floka-ai/cloud/pull/12";
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
/** A merge-stage card whose passing review is proved, exactly the shape the planner turns into a merge intent. */
const mergeReady = (pr: string | null): PlannerSnapshot => ({
  task: task("merge", pr), workflow: { ...workflow }, intents: [sentReview], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"],
  events: [event(1, "task", { op: "new" }), event(11, "stage", { from: "build", to: "review", round: 1 }), event(19, "deliver", { round: 1, headSHA: HEAD }),
    event(20, "review", { round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: reviewer.family,
      path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0 }),
    event(31, "stage", { from: "review", to: "merge", round: 1 })],
  heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [{ intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 16 }],
  uiGate: { state: "none" }, screenshotsDigest: null,
});

afterEach(() => setForeignRepoLookupForTest({ project: null, origin: null }));

describe("i28-SECPOOL4 repository facts", () => {
  test("card repo is the PR link's, else a well-formed extra.repo; origin forms read like GitHub's", () => {
    expect(cardRepo({ pr: PRIVATE, extra: { repo: "shawnlu96/claudestra" } })).toBe("floka-ai/cloud");
    expect(cardRepo({ pr: null, extra: { repo: "Floka-AI/Cloud" } })).toBe("floka-ai/cloud");
    expect(cardRepo({ pr: "not a link", extra: { repo: "x/y.git" } })).toBeNull();
    expect(githubRepoOf("git@github.com:shawnlu96/claudestra.git")).toBe("shawnlu96/claudestra");
    expect(githubRepoOf("https://github.com/Floka-AI/cloud\n")).toBe("floka-ai/cloud");
    expect(githubRepoOf("https://gitlab.com/a/b")).toBeNull();
    expect(foreignRepoOf({ pr: PRIVATE, extra: {} }, "shawnlu96/claudestra")).toBe("floka-ai/cloud");
    expect(foreignRepoOf({ pr: PUBLIC, extra: {} }, "shawnlu96/claudestra")).toBeNull();
    expect(foreignRepoOf({ pr: PRIVATE, extra: {} }, null)).toBeNull(); // project repository unknown: no verdict
    expect(foreignRepoOf({ pr: null, extra: {} }, "shawnlu96/claudestra")).toBeNull();
  });

  test("the project repo is repoDir's origin; remote.repo only when the origin cannot be read; the origin read is cached", () => {
    let reads = 0;
    setForeignRepoLookupForTest({ origin: () => { reads++; return "shawnlu96/claudestra"; } });
    const policy = { repoDir: "/r", remote: { repo: "Floka-AI/cloud" } } as Parameters<typeof projectRepo>[0];
    expect(projectRepo(policy)).toBe("shawnlu96/claudestra"); // a conflicting remote.repo never becomes a second project repository
    expect(projectRepo(policy)).toBe("shawnlu96/claudestra");
    expect(reads).toBe(1);
    setForeignRepoLookupForTest({ origin: () => null });
    expect(projectRepo(policy)).toBe("floka-ai/cloud");
    expect(projectRepo({ repoDir: "/r" } as Parameters<typeof projectRepo>[0])).toBeNull();
    expect(projectRepo(undefined)).toBeNull();
  });

  test("a failing origin read is logged (once) and falls back to remote.repo, never thrown into the caller", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setForeignRepoLookupForTest({ origin: () => { throw new Error("permission denied"); } });
      const policy = { repoDir: "/r", remote: { repo: "shawnlu96/claudestra" } } as Parameters<typeof projectRepo>[0];
      expect(projectRepo(policy)).toBe("shawnlu96/claudestra");
      expect(projectRepo({ repoDir: "/r" } as Parameters<typeof projectRepo>[0])).toBeNull(); // cached unknown, no second log
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("permission denied");
    } finally { warn.mockRestore(); }
  });

  test("a repoDir that does not exist reads as no origin: null, nothing printed (the real git lookup, not a stub)", () => {
    const spies = (["warn", "error", "log", "info", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      setForeignRepoLookupForTest({ origin: null });
      const missing = `/tmp/secpool4-no-such-dir-${process.pid}-${Date.now()}`;
      expect(projectRepo({ repoDir: missing } as Parameters<typeof projectRepo>[0])).toBeNull();
      expect(projectRepo({ repoDir: missing } as Parameters<typeof projectRepo>[0], { fresh: true })).toBeNull();
      expect(projectRepo({ repoDir: missing, remote: { repo: "shawnlu96/claudestra" } } as Parameters<typeof projectRepo>[0], { fresh: true }))
        .toBe("shawnlu96/claudestra");
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { for (const s of spies) s.mockRestore(); }
  });
});

describe("i28-SECPOOL4 planner", () => {
  test("P1-1: a merge-stage card whose PR is in floka-ai/cloud gets no merge intent, it escalates foreign_repo with the repo", () => {
    const d = planScheduler({ ...mergeReady(PRIVATE), projectRepo: "shawnlu96/claudestra" });
    expect(d).toMatchObject({ kind: "escalate", code: "foreign_repo" });
    expect(d.kind === "escalate" && d.reason).toContain("floka-ai/cloud");
    expect(d.kind === "escalate" && d.reason).toContain("不是项目自动合并的仓库");
    // no PR link yet: extra.repo decides
    const s = { ...mergeReady(null), projectRepo: "shawnlu96/claudestra" };
    s.task.extra = { repo: "floka-ai/cloud" };
    expect(planScheduler(s)).toMatchObject({ kind: "escalate", code: "foreign_repo" });
  });

  test("P1-2: the same card with its PR in shawnlu96/claudestra plans exactly what it planned before", () => {
    const before = planScheduler(mergeReady(PUBLIC)); // no projectRepo in the snapshot: no verdict
    expect(before).toMatchObject({ kind: "intent", action: "merge" });
    expect(planScheduler({ ...mergeReady(PUBLIC), projectRepo: "shawnlu96/claudestra" })).toEqual(before);
    // unknown project repository: unchanged too
    expect(planScheduler({ ...mergeReady(PRIVATE), projectRepo: null })).toEqual(planScheduler({ ...mergeReady(PRIVATE) }));
    expect(planScheduler({ ...mergeReady(PRIVATE), projectRepo: null })).toMatchObject({ kind: "intent", action: "merge" });
  });

  test("an in-flight merge intent still waits on the ledger; other stages are untouched", () => {
    const s = { ...mergeReady(PRIVATE), projectRepo: "shawnlu96/claudestra" };
    s.intents = [...s.intents, { ...sentReview, id: "m1", node: "merge_deploy", action: "merge", status: "submitted", causalSeq: 31, eventSeq: 32 }];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "in_flight" });
    const review = { ...mergeReady(PRIVATE), projectRepo: "shawnlu96/claudestra" };
    review.task = task("review", PRIVATE);
    expect(planScheduler(review)).not.toMatchObject({ code: "foreign_repo" });
  });
});

describe("i28-SECPOOL4 inspect refusal", () => {
  const policy = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/project" } } }).projects.p;
  test("repoDir in another repository than the PR: a marked refusal with the PR's repository, before any pr view", async () => {
    const calls: string[][] = [];
    const command: typeof runBounded = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: '{"nameWithOwner":"shawnlu96/claudestra"}', stderr: "", timedOut: false };
    };
    const err = await mergeExternal(policy, command).inspect(PRIVATE).catch((e: unknown) => e);
    expect(isForeignRepoError(err)).toBe(true);
    expect(err).toMatchObject({ code: "foreign_repo", prRepo: "floka-ai/cloud", message: "repoDir 仓库与 PR 仓库不一致" });
    expect(calls).toEqual([["gh", "repo", "view", "--json", "nameWithOwner"]]);
    expect(isForeignRepoError(new Error("repoDir 仓库与 PR 仓库不一致"))).toBe(false);
  });
});

describe("i28-SECPOOL4 manual reason", () => {
  test("P1-5: foreign_repo parses and renders; the older codes parse exactly as before", () => {
    const p = parseManualReason("foreign_repo：卡在 floka-ai/cloud，不是项目自动合并的仓库：由 PM 按该仓库的流程手动合并和部署");
    expect(p).toMatchObject({ code: "foreign_repo", explicit: true, text: expect.stringContaining("floka-ai/cloud") });
    expect(MANUAL_REASON_CODES.at(-1)).toBe("foreign_repo");
    expect(MANUAL_REASON_CODES.slice(0, -1)).toEqual(["safety_refusal", "ui_evidence_stale", "merge_unknown", "write_lease_ended", "deps_not_live",
      "materials_gate", "questionnaire", "review_unresolved", "review_source_missing", "runtime_unavailable", "spec_drift", "owner_hold",
      "start_rollback", "pm_hold", "pm_takeover"]);
    for (const [line, code] of [["PM 接手核对", "pm_takeover"], ["合并结果不明", "merge_unknown"], ["跨仓 PR", "spec_drift"],
      ["merge_retry_requires_pm：合并意图已取消", "merge_unknown"], ["owner_hold: 等 owner", "owner_hold"]] as const) {
      expect(parseManualReason(line)?.code).toBe(code);
    }
  });
});
