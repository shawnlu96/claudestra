/**
 * i28-M12: what follows a merge bounce. The fix package is "resolve the conflict / fix CI", never a P1 report nor a P1 round;
 * the re-review is targeted and is not a carried review; the 4th bounce asks the PM to schedule. Also the inspect boundary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { orderWireFor } from "../src/lib/order-take.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { BOUNCE_LIMIT_REASON, type MergeBounce } from "../src/lib/scheduler-merge-conflict.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";

const H = "a".repeat(40), MAIN = "e".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "s-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "s-review", taskId: "T1", family: "codex", source: "local" };
const conflict: MergeBounce = { cause: "conflict", prHead: H, mainHead: MAIN, checks: [] };
const ciFail: MergeBounce = { cause: "ci_fail", prHead: H, mainHead: null, checks: [{ name: "check", link: "https://github.com/x/y/actions/runs/1" }] };

let seq = 1;
const ev = (kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
  ({ seq: ++seq, kind, data, ts: seq, actor: "scheduler", project: "p", target: "T1", text: "", dedupKey: null });
const P1 = { findingId: "race-1", family: "race", severity: "P1", probe: "p" };
const review = (round: number, findings: unknown[]) => ev("review", { round, head: H, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId,
  reviewerFamily: "codex", path: `reviews/T1-r${round}/report.md`, verdict: findings.length ? "changes" : "pass", findings,
  p0: 0, p1: findings.length, p2: 0 });
/** Three P1 rounds on the same finding, then a pass, merge, and a bounce: a P1 fix here would hit the "3 rounds" fallback. */
function history(bounce: MergeBounce): LedgerEvent[] {
  seq = 1;
  return [ev("task", { op: "new" }), review(1, [P1]), ev("stage", { from: "review", to: "fix", round: 1 }), review(2, [P1]),
    ev("stage", { from: "review", to: "fix", round: 2 }), review(3, [P1]), ev("stage", { from: "review", to: "fix", round: 3 }),
    review(4, []), ev("stage", { from: "review", to: "merge", round: 4 }),
    ev("stage", { from: "merge", to: "fix", round: 4, specRev: 1, head: H, mergeBounce: bounce })];
}
const task = (stage: LedgerTask["stage"], round: number): LedgerTask => ({ id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage,
  stageBefore: null, round, agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "pm", branch: "task/T1",
  pr: "https://github.com/x/y/pull/1", headSHA: H, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1 });
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const snap = (t: LedgerTask, events: LedgerEvent[], intents: SchedulerIntent[] = []): PlannerSnapshot => ({
  task: t, workflow, events, intents, blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer, reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});
const ref = { agent: author.agent, sessionId: author.sessionId, taskId: "T1", family: "claude" as const, role: "author" as const, transport: "tmux" as const };

describe("i28-M12 bounce fix package", () => {
  for (const b of [conflict, ciFail]) {
    test(`${b.cause}: fix dispatch carries the bounce, not a P1 report, and the P1 round history does not escalate it`, () => {
      const d = planScheduler(snap(task("fix", 4), history(b)));
      expect(d).toMatchObject({ kind: "intent", action: "dispatch", workOrder: { bounce: b, reportPath: "", findings: [], fallbackWarning: null } });
      if (d.kind !== "intent") return;
      const order = workOrderFor(task("fix", 4), { id: d.id, node: "fix", head: H, specRev: 1 } as SchedulerIntent, d, ref)!;
      expect(order.inputs.join("\n")).not.toContain("审查报告");
      expect(order.inputs.join("\n")).toContain(b.cause === "conflict" ? "解冲突" : "PR 头 CI 失败：check（https://github.com/x/y/actions/runs/1）");
      expect(order.acceptance.join("\n")).toContain(b.cause === "conflict" ? "只 git add 冲突文件" : "看 CI 日志");
      expect(order.findings).toEqual([]);
    });
  }
  test("a P1 fix right after the same history still escalates (the bounce path is the only bypass)", () => {
    const events = history(conflict).slice(0, -3);
    events.push(review(4, [P1]), ev("stage", { from: "review", to: "fix", round: 4 }));
    expect(planScheduler(snap(task("fix", 4), events))).toMatchObject({ kind: "escalate", code: "fix_history" });
  });
});

describe("i28-M12 targeted re-review", () => {
  test("after the bounce fix is delivered, the review order says targeted, and nothing is carried", () => {
    const events = [...history(conflict), ev("deliver", { round: 4, headSHA: H }), ev("stage", { from: "fix", to: "review", round: 5 })];
    const d = planScheduler(snap(task("review", 5), events));
    expect(d).toMatchObject({ kind: "intent", action: "review", workOrder: { bounce: conflict } });
    if (d.kind !== "intent") return;
    const order = workOrderFor(task("review", 5), { id: d.id, node: d.node, head: H, specRev: 1 } as SchedulerIntent, d,
      { ...ref, agent: reviewer.agent, sessionId: reviewer.sessionId, family: "codex", role: "reviewer" })!;
    expect(order.inputs.join("\n")).toContain("定向复验");
    expect(order.inputs.join("\n")).toContain("不沿用旧审查");
  });
  test("an ordinary P1 re-review carries no bounce line", () => {
    seq = 1;
    const events = [ev("task", { op: "new" }), review(1, [P1]), ev("stage", { from: "review", to: "fix", round: 1 }),
      ev("deliver", { round: 1, headSHA: H }), ev("stage", { from: "fix", to: "review", round: 2 })];
    const d = planScheduler(snap(task("review", 2), events));
    expect(d).toMatchObject({ kind: "intent", action: "review" });
    if (d.kind === "intent") expect(d.workOrder).toBeUndefined();
  });
});

describe("i28-M12 bounce limit", () => {
  test("a merge intent cancelled by the 4th bounce escalates with the scheduling reason", () => {
    const events = history(conflict).slice(0, -1);
    const since = events.at(-1)!.seq;
    const cancelled = { id: "m4", taskId: "T1", project: "p", node: "merge_deploy", action: "merge", recipient: null, causalSeq: since, eventSeq: since + 1,
      taskRev: 1, specRev: 1, head: H, templateVersion: 2, status: "cancelled", attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 } as SchedulerIntent;
    events.push(ev("scheduler", { op: "merge_conflict", intentId: "m4", cause: "conflict", count: 4, escalated: true }));
    expect(planScheduler(snap(task("merge", 4), events, [cancelled]))).toMatchObject({ kind: "escalate", code: "merge_bounce_limit", reason: BOUNCE_LIMIT_REASON });
    events.pop();
    expect(planScheduler(snap(task("merge", 4), events, [cancelled]))).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
  });
});

describe("i28-M12 take_order fix wire", () => {
  test("a bounce fix order lists the conflict work and no review report; a P1 fix order is unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "m12-take-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "t", kind: "code", agent: author.agent });
      db.query("UPDATE tasks SET stage='fix', round=4, headSHA=?, branch='task/T1' WHERE id='T1'").run(H);
      const add = (kind: string, data: unknown) => db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (2,'scheduler','p','T1',?,'',?)")
        .run(kind, JSON.stringify(data));
      add("review", { round: 4, head: H, verdict: "pass", reviewer: "r", reviewerSessionId: "s", reviewerFamily: "codex", path: "/x/T1-r4.md", findings: [], p0: 0, p1: 0, p2: 0 });
      add("stage", { from: "merge", to: "fix", round: 4, mergeBounce: conflict });
      const order = () => {
        const w = orderWireFor(db, { task: getTask(db, "T1")!, stage: "fix", step: "fix", orderId: "T1:fix:r4", intent: null });
        if (!w.ok) throw new Error(w.error);
        return w.order;
      };
      expect(order().inputs.join("\n")).toContain("解冲突");
      expect(order().inputs.join("\n")).not.toContain("审查报告");
      expect(order().acceptance.join("\n")).toContain("合入最新 origin/main");
      add("stage", { from: "review", to: "fix", round: 4 });
      expect(order().inputs.join("\n")).toContain("上一轮审查报告");
      expect(order().inputs.join("\n")).not.toContain("解冲突");
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("i28-M12 inspect without CI", () => {
  const policy = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: "/tmp/p" } } }).projects.p;
  const adapter = (mergeState: string, checks: { stdout: string; timedOut?: boolean }) => mergeExternal(policy, (async (argv: string[]) => {
    if (argv[1] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "", timedOut: false };
    if (argv[2] === "view") return { code: 0, stderr: "", timedOut: false, stdout: JSON.stringify({ state: "OPEN", headRefOid: H, headRefName: "task/T1",
      baseRefName: "main", isDraft: false, isCrossRepository: false, mergeStateStatus: mergeState, mergeCommit: null }) };
    expect(argv).toEqual(["gh", "pr", "checks", "https://github.com/example/repo/pull/42", "--json", "bucket,name,link"]);
    return { code: 1, stdout: checks.stdout, stderr: "no checks reported on the 'task/T1' branch", timedOut: checks.timedOut ?? false };
  }) as typeof runBounded);
  test("no checks + DIRTY in the same view → empty checks", async () => {
    expect((await adapter("DIRTY", { stdout: "" }).inspect("https://github.com/example/repo/pull/42")).checks).toEqual([]);
  });
  test("no checks + anything but DIRTY, or a timeout even when DIRTY → still throws", async () => {
    for (const state of ["CLEAN", "BLOCKED", "BEHIND", "UNSTABLE"]) {
      await expect(adapter(state, { stdout: "" }).inspect("https://github.com/example/repo/pull/42")).rejects.toThrow(/无结果/);
    }
    await expect(adapter("DIRTY", { stdout: "", timedOut: true }).inspect("https://github.com/example/repo/pull/42")).rejects.toThrow(/无结果/);
  });
  test("checks keep their run link", async () => {
    const out = JSON.stringify([{ name: "check", bucket: "fail", link: "https://github.com/x/y/actions/runs/1" }]);
    expect((await adapter("UNSTABLE", { stdout: out }).inspect("https://github.com/example/repo/pull/42")).checks)
      .toEqual([{ name: "check", bucket: "fail", link: "https://github.com/x/y/actions/runs/1" }]);
  });
});
