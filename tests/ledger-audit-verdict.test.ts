import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditFinding } from "../src/lib/ledger-audit.js";
import type { SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import type { WorkflowMode } from "../src/lib/ledger-scheduler.js";
import type { ReviewVerdict } from "../src/lib/ledger-stages.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const MIN = 60_000, NOW = 1_000 * MIN, P = "verdict", PM = "agent-pm", DISPATCH = "agent-dispatch", ID = "VERDICT1";
let dir: string, path: string, db: Database;
let reviewers: NonNullable<ReturnType<SnapshotSources["reviewers"]>>;
const ctx = (now: number) => ({ actor: "owner", now });

function sources(): SnapshotSources {
  return {
    registry: async () => [PM, DISPATCH].map((name) => ({ name, projectId: P })),
    windows: async () => [PM, DISPATCH], turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => reviewers,
    heldPath: join(dir, "held.json"),
  };
}

// The same injected-clock entry used by `ledger audit --dry-run`; no bridge, tmux, peer or GitHub source runs here.
async function audit(now = NOW, args = ["--dry-run"]): Promise<{
  ok: boolean; projects: { open: AuditFinding[]; skipped: { rule: string; reason: string }[] }[]; pending?: AuditFinding[];
}> {
  const result = await runLedger(["audit", "--project", P, "--json", ...args], {
    db, actor: "owner", actorProject: P, projectIds: [P], now: () => now, auditSources: sources(),
    loadRegistry: async () => { throw new Error("audit must not load the real registry"); },
    saveRegistry: async () => { throw new Error("audit must not save the registry"); },
  });
  expect(result.ok).toBe(true);
  return result as Awaited<ReturnType<typeof audit>>;
}

function seed(mode: WorkflowMode | null = "manual"): void {
  createTask(db, ctx(0), { project: P, id: ID, title: ID, kind: "code", stage: "spec" });
  if (mode) setWorkflow(db, ctx(MIN), {
    taskId: ID, taskRev: 1, workflowRev: 0, template: "code", templateVersion: 2, mode,
    authorFamily: "claude", fallback: "PM 核对", reason: "pm_hold: PM 留人工",
  });
  moveStage(db, ctx(2 * MIN), { taskId: ID, from: "spec", to: "restate" });
  moveStage(db, ctx(3 * MIN), { taskId: ID, from: "restate", to: "build" });
  moveStage(db, ctx(NOW - 60 * MIN), { taskId: ID, from: "build", to: "review" });
}

function verdict(value: ReviewVerdict = "changes", age = 6 * MIN) {
  return recordReview(db, ctx(NOW - age), {
    taskId: ID, reviewer: "reviewer", verdict: value, p0: value === "block" ? 1 : 0, p1: value === "pass" ? 0 : 1,
    p2: 2, path: "/reports/VERDICT1-r1.md",
  }).event;
}

const reviewFindings = (r: Awaited<ReturnType<typeof audit>>) => r.projects[0].open.filter((f) => f.rule.startsWith("review_"));
const rules = (r: Awaited<ReturnType<typeof audit>>) => reviewFindings(r).map((f) => f.rule);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-verdict-"));
  path = join(dir, "ledger.sqlite"); db = openLedger(path); reviewers = [];
  setMeta(db, ctx(0), { project: P, key: "pms", value: [PM, DISPATCH] });
  await audit(0, []); // Real first-run baseline, before a verdict arrives.
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

describe("ledger audit verdict idle via the real ledger schema and CLI entry", () => {
  test("manual changes 6 minutes: review_verdict_idle, never review_no_reviewer (old red / new green)", async () => {
    seed(); const e = verdict();
    const r = await audit();
    expect(rules(r)).toEqual(["review_verdict_idle"]);
    expect(reviewFindings(r)[0]).toMatchObject({
      since: e.ts, notify: PM, key: `${P}|review_verdict_idle|${ID}|r1|${e.seq}`,
      detail: expect.stringContaining("changes（P0 0 / P1 1 / P2 2）已 6 分钟"),
      suggestion: expect.stringContaining("看报告 /reports/VERDICT1-r1.md，推 fix 或开下一轮"),
    });
  });

  test("manual changes 25 minutes: replaces the old false 'no reviewer' alarm (old red / new green)", async () => {
    seed(); verdict("changes", 25 * MIN);
    expect(rules(await audit())).toEqual(["review_verdict_idle"]);
  });

  for (const mode of ["manual", null] as const) {
    test(`${mode ?? "no workflow row"}: 4 / exactly 5 minutes quiet, 5 minutes + 1ms fires`, async () => {
      seed(mode); verdict();
      expect(rules(await audit(NOW - 2 * MIN))).toEqual([]);
      expect(rules(await audit(NOW - MIN))).toEqual([]);
      expect(rules(await audit(NOW - MIN + 1))).toEqual(["review_verdict_idle"]);
    });
  }

  for (const mode of ["auto", "observe"] as const) {
    test(`${mode} changes: 6 / exactly 20 minutes quiet, 20 minutes + 1ms / 21 minutes fires`, async () => {
      seed(mode); verdict();
      expect(rules(await audit())).toEqual([]);
      expect(rules(await audit(NOW + 14 * MIN))).toEqual([]);
      expect(rules(await audit(NOW + 14 * MIN + 1))).toEqual(["review_verdict_idle"]);
      expect(rules(await audit(NOW + 15 * MIN))).toEqual(["review_verdict_idle"]);
    });
  }

  test("block includes all severity counts and the recorded report", async () => {
    seed(); verdict("block");
    expect(reviewFindings(await audit())[0]).toMatchObject({
      rule: "review_verdict_idle", detail: expect.stringContaining("block（P0 1 / P1 1 / P2 2）"),
      suggestion: expect.stringContaining("/reports/VERDICT1-r1.md"),
    });
  });

  for (const mode of ["manual", null, "auto", "observe"] as const) {
    test(`${mode ?? "no workflow row"} pass: manual 5 minutes, auto / observe 30 minutes`, async () => {
      seed(mode); verdict("pass");
      const manual = mode === "manual" || mode === null;
      expect(rules(await audit(NOW - MIN))).toEqual([]);
      expect(rules(await audit())).toEqual(manual ? ["review_passed_idle"] : []);
      expect(rules(await audit(NOW + 24 * MIN))).toEqual(manual ? ["review_passed_idle"] : []);
      expect(rules(await audit(NOW + 24 * MIN + 1))).toEqual(["review_passed_idle"]);
    });
  }

  test("notes after a verdict do not reset the verdict clock", async () => {
    seed(); verdict();
    appendEvent(db, ctx(NOW - MIN), { project: P, target: ID, kind: "note", text: "查看中" });
    expect(rules(await audit())).toEqual(["review_verdict_idle"]);
  });

  for (const step of ["review", "final_review"] as const) for (const executorKind of ["agent", "peer"] as const) {
    test(`a new ${executorKind} ${step} assignment after the verdict suppresses the idle alarm`, async () => {
      seed(); verdict("changes", 25 * MIN);
      assignStep(db, ctx(NOW - MIN), { taskId: ID, step, executor: executorKind === "peer" ? "reviewer@peer" : "agent-reviewer", executorKind });
      expect(rules(await audit())).toEqual([]);
    });
  }

  test("a review assignment before the verdict does not suppress it, including peer steps left pending", async () => {
    seed(); assignStep(db, ctx(NOW - 10 * MIN), { taskId: ID, step: "review", executor: "reviewer@peer", executorKind: "peer" });
    verdict();
    expect(rules(await audit())).toEqual(["review_verdict_idle"]);
  });

  test("a same-millisecond assignment uses event seq to recognise the newer review", async () => {
    seed(); verdict();
    assignStep(db, ctx(NOW - 6 * MIN), { taskId: ID, step: "review", executor: "reviewer@peer", executorKind: "peer" });
    expect(rules(await audit())).toEqual([]);
  });

  test("a same-millisecond assignment before the verdict does not hide it", async () => {
    seed();
    assignStep(db, ctx(NOW - 6 * MIN), { taskId: ID, step: "review", executor: "reviewer@peer", executorKind: "peer" });
    verdict();
    expect(rules(await audit())).toEqual(["review_verdict_idle"]);
  });

  test("a verdict before reentering review in the same millisecond is still an old verdict", async () => {
    seed(); verdict();
    moveStage(db, ctx(NOW - 6 * MIN), { taskId: ID, from: "review", to: "fix" });
    moveStage(db, ctx(NOW - 6 * MIN), { taskId: ID, from: "fix", to: "review" });
    expect(rules(await audit())).toEqual([]);
  });

  test("a changed stage and an old verdict before reentering review do not raise verdict idle", async () => {
    seed(); verdict();
    moveStage(db, ctx(NOW - MIN), { taskId: ID, from: "review", to: "fix" });
    expect(rules(await audit())).toEqual([]);
    moveStage(db, ctx(NOW), { taskId: ID, from: "fix", to: "review" });
    expect(rules(await audit(NOW + 6 * MIN))).toEqual([]);
    expect(rules(await audit(NOW + 21 * MIN))).toEqual(["review_no_reviewer"]);
  });

  test("last review verdict wins and a genuinely unassigned review still raises no reviewer", async () => {
    seed(); expect(rules(await audit())).toEqual(["review_no_reviewer"]);
    verdict("changes", 25 * MIN); verdict("pass");
    expect(rules(await audit())).toEqual(["review_passed_idle"]);
  });

  test("running or unavailable reviewer sources preserve the existing suppression / skip behavior", async () => {
    seed(); verdict(); reviewers = [{ taskId: ID.toLowerCase(), round: 1 }];
    expect(rules(await audit())).toEqual([]);
    reviewers = { error: "reviewers unreadable" };
    const r = await audit();
    expect(rules(r)).toEqual([]);
    expect(r.projects[0].skipped).toContainEqual({ rule: "review_verdict_idle", reason: "reviewers unreadable" });
  });

  test("two patrols notify once after ack; a new review event gets a new dedup key", async () => {
    seed(); const first = verdict();
    const a = await audit(NOW, []);
    expect(a.pending?.map((f) => f.rule)).toEqual(["review_verdict_idle"]);
    await audit(NOW, ["--ack", a.pending![0].key]);
    expect((await audit(NOW + MIN, [])).pending).toEqual([]);
    moveStage(db, ctx(NOW + MIN), { taskId: ID, from: "review", to: "fix" });
    moveStage(db, ctx(NOW + 2 * MIN), { taskId: ID, from: "fix", to: "review" });
    const next = recordReview(db, ctx(NOW + 3 * MIN), {
      taskId: ID, reviewer: "reviewer", verdict: "changes", p0: 0, p1: 1, p2: 0, path: "/reports/VERDICT1-r2.md",
    }).event;
    const b = await audit(NOW + 9 * MIN, []);
    expect(b.pending).toHaveLength(1);
    expect(b.pending![0].key).toBe(`${P}|review_verdict_idle|${ID}|r2|${next.seq}`);
    expect(next.seq).not.toBe(first.seq);
  });

  test("dry-run and persisted patrol leave all task, step, workflow and event rows unchanged", async () => {
    seed(); verdict();
    const rows = () => ["tasks", "task_steps", "task_workflows", "events"].map((table) => db.query(`SELECT * FROM ${table}`).all());
    const before = rows();
    await audit(); expect(rows()).toEqual(before);
    await audit(NOW, []); expect(rows()).toEqual(before);
  });

  test("dry-run works with SQLite query_only and writes no audit rows", async () => {
    seed(); verdict();
    const before = db.query("SELECT * FROM audit_findings").all();
    db.exec("PRAGMA query_only = ON");
    try {
      expect(rules(await audit())).toEqual(["review_verdict_idle"]);
      expect(db.query("SELECT * FROM audit_findings").all()).toEqual(before);
    } finally { db.exec("PRAGMA query_only = OFF"); }
  });
});
