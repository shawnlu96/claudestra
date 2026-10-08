import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { fallbackToManual } from "../src/lib/scheduler-fallback.js";
import { fixStrategy } from "../src/lib/fix-strategy.js";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { abortedReviewRounds, openReviewRound } from "../src/lib/review-round-abort.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts, p1AnyStreak, p1FindingStreak, type ReviewFacts } from "../src/lib/scheduler-review.js";

// Synthetic replay of E2BR-1 (2026-10-07): r5 was dispatched (4734), taken (4740), hit "model at capacity" (4742), PM moved
// the stage and the card fell back to manual (4741/4743); r5 never got a verdict and every later P1 streak returned null.
const head = (r: number) => r.toString(16).padStart(40, "0");
const author: WorkerRef = { agent: "agent-author", sessionId: "s-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-rv", sessionId: "s-rv", taskId: "T1", family: "codex", source: "local" };
type Sev = "P1" | "P2";
const f = (id: string, severity: Sev = "P1") => ({ findingId: id, family: id, severity, probe: `[验收线 1] docs/x.md:1 ${id}` });
let seq = 0;
const ev = (kind: LedgerEvent["kind"], data: Record<string, unknown>, actor = "scheduler"): LedgerEvent =>
  ({ seq: ++seq, ts: seq, actor, project: "p", target: "T1", kind, text: "", data, dedupKey: null });
const reviewIntent = (r: number) => `t68:s${r}:r${r}:adversarial_review:a0`;
const plan = (r: number) => ev("scheduler", { op: "plan", id: reviewIntent(r), node: "adversarial_review",
  action: "review", recipient: reviewer.agent, head: head(r) });
const settled = (r: number, to: string) => ev("scheduler", { op: "settle", id: reviewIntent(r), from: "pending", to });
const verdict = (r: number, rows: ReturnType<typeof f>[]) => ev("review", { round: r, head: head(r), reviewer: reviewer.agent,
  reviewerSessionId: reviewer.sessionId, reviewerFamily: "codex", path: `reviews/T1-r${r}.md`, verdict: rows.length ? "changes" : "pass",
  findings: rows, p0: 0, p1: rows.filter((x) => x.severity === "P1").length, p2: rows.filter((x) => x.severity === "P2").length }, reviewer.agent);

/** Rounds in order; `null` = dispatched and taken, then interrupted (no verdict). `dispatched: false` drops the dispatch evidence. */
function history(rounds: (ReturnType<typeof f>[] | null)[], o: { dispatched?: boolean } = {}): LedgerEvent[] {
  seq = 0;
  const out = [ev("task", { op: "new" }), ev("scheduler", { op: "workflow", specRev: 1, mode: "auto" })];
  rounds.forEach((rows, i) => {
    const r = i + 1;
    out.push(ev("stage", { from: r === 1 ? "build" : "fix", to: "review", round: r }), ev("deliver", { round: r, headSHA: head(r) }, author.agent));
    if (rows || o.dispatched !== false) out.push(plan(r), settled(r, "submitted"), settled(r, "done"),
      ev("scheduler", { op: "order_taken", id: reviewIntent(r) }, reviewer.agent));
    if (rows) out.push(verdict(r, rows), ev("stage", { from: "review", to: "fix", round: r }));
    else out.push(ev("note", { op: "supervise", fault: "overload" }), ev("stage", { from: "review", to: "fix", round: r }, "agent-pm"),
      ev("scheduler", { op: "fallback_manual", reason: "fix_report：修复阶段缺上一轮完整审查报告" }),
      ev("scheduler", { op: "workflow_resume", manual: true }));
  });
  return out.slice(0, -1); // the last round's verdict has just landed: the card still sits in review
}

const E2BR = [[f("a"), f("b"), f("c"), f("d"), f("e", "P2")], [f("a"), f("b"), f("e", "P2"), f("g", "P2")], [f("e", "P2")],
  [f("freeze"), f("lease"), f("handed"), f("e", "P2")], null, [f("freeze"), f("lease"), f("status"), f("cite")], [f("withdraw")]];

function snapshot(events: LedgerEvent[], round: number): PlannerSnapshot {
  const plan = events.findLast((e) => e.data.op === "plan")!, taken = events.findLast((e) => e.data.op === "order_taken")!;
  const task: LedgerTask = { id: "T1", project: "p", itemId: null, title: "RVH", kind: "code", stage: "review", stageBefore: null, round,
    agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null, headSHA: head(round),
    spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1 };
  const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
    fallback: "PM 接管", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
  const sent: SchedulerIntent = { id: `review-r${round}`, taskId: "T1", project: "p", node: "adversarial_review", action: "review",
    recipient: reviewer.agent, causalSeq: plan.seq - 1, eventSeq: plan.seq, taskRev: 1, specRev: 1, head: head(round), templateVersion: 2, status: "done",
    attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 };
  return { task, workflow, events, intents: [sent], blockedBy: [], queueFrozen: false, fileGlobs: ["docs/*.md"], heldResources: [],
    workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer, uiGate: { state: "none" }, screenshotsDigest: null,
    reviewDispatches: [{ intentId: sent.id, round, head: head(round), reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: taken.seq }] };
}
const factsOf = (events: LedgerEvent[], round: number): ReviewFacts => {
  const read = currentReviewFacts({ round, headSHA: head(round), specRev: 1 }, events);
  if (read.kind !== "facts") throw new Error(`no facts: ${read.kind}`);
  return read.facts;
};

describe("RVH-1 interrupted review rounds", () => {
  test("E2BR-1 replay: r6 and r7 verdicts go on to fix instead of falling back with review_history", () => {
    for (const round of [6, 7]) {
      const events = history(E2BR.slice(0, round));
      expect([...abortedReviewRounds(events, round)]).toEqual([5]);
      expect(planScheduler(snapshot(events, round))).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
    }
    // r6: freeze/lease were already P1 in r4; r5 is skipped, not a break, so they stay a 2-round streak (fresh session).
    const events = history(E2BR.slice(0, 6));
    expect(p1AnyStreak(events, 6)).toBe(2);
    expect(p1FindingStreak(events, f("freeze"), 6)).toBe(2);
    expect(p1FindingStreak(events, f("status"), 6)).toBe(1);
    expect(fixStrategy(events, factsOf(events, 6), "claude")?.mode).toBe("fresh_session");
    expect(p1AnyStreak(history(E2BR), 7)).toBe(3);
  });

  test("a gap that was never dispatched still proves nothing: review_history as before", () => {
    const events = history(E2BR.slice(0, 6), { dispatched: false });
    expect(abortedReviewRounds(events, 6).size).toBe(0);
    expect(p1AnyStreak(events, 6)).toBeNull();
    expect(planScheduler(snapshot(events, 6))).toMatchObject({ kind: "escalate", code: "review_history" });
  });

  test("a real same P1 three rounds in a row still escalates, with or without an interrupted round in between", () => {
    const straight = history([[f("x")], [f("x")], [f("x")]]);
    expect(p1FindingStreak(straight, f("x"), 3)).toBe(3);
    expect(fixStrategy(straight, factsOf(straight, 3), "claude")?.mode).toBe("fresh_session");
    const gapped = history([[f("x")], null, [f("x")], [f("x")]]);
    expect(p1FindingStreak(gapped, f("x"), 4)).toBe(3);
    expect(fixStrategy(gapped, factsOf(gapped, 4), "claude")?.mode).toBe("fresh_session");
    const four = history([[f("x")], [f("x")], null, [f("x")], [f("x")]]);
    expect(fixStrategy(four, factsOf(four, 5), "claude")).toMatchObject({ mode: "other_family", family: "codex" });
  });

  test("a planned review that was never delivered (pending, then cancelled by fallback) stays missing", () => {
    const base = history([[f("x")], null, [f("x")]], { dispatched: false });
    const planned = [...base.slice(0, 2), plan(2), settled(2, "cancelled"), ...base.slice(2)];
    expect(abortedReviewRounds(planned, 3).size).toBe(0);
    expect(openReviewRound([...history([[f("x")], null], { dispatched: false }), plan(2), settled(2, "cancelled")])).toBeNull();
    expect(p1AnyStreak(planned, 3)).toBeNull();
    // claimed but not yet confirmed (submitted) proves nothing; done or the reviewer taking it does
    expect(abortedReviewRounds([...planned, settled(2, "submitted")], 3).size).toBe(0);
    expect([...abortedReviewRounds([...planned, settled(2, "done")], 3)]).toEqual([2]);
    expect([...abortedReviewRounds([...planned, ev("scheduler", { op: "order_taken", id: reviewIntent(2) }, reviewer.agent)], 3)]).toEqual([2]);
  });

  test("a claimed dispatch the recipient rejected (pending→submitted→cancelled, 未投递) stays missing", () => {
    // scheduler-dispatch.ts settles pending→submitted before worker.submit; a rejection then settles submitted→cancelled
    const rejected = [plan(2), ev("scheduler", { op: "settle", id: reviewIntent(2), from: "pending", to: "submitted", receipt: "claimed; route=ws" }),
      ev("scheduler", { op: "settle", id: reviewIntent(2), from: "submitted", to: "cancelled", receipt: "未投递：收件人拒绝" })];
    const base = history([[f("x")], null, [f("x")]], { dispatched: false });
    const events = [...base.slice(0, 2), ...rejected, ...base.slice(2)];
    expect(abortedReviewRounds(events, 3).size).toBe(0);
    expect(p1AnyStreak(events, 3)).toBeNull();
    expect(openReviewRound([...history([[f("x")], null], { dispatched: false }), ...rejected])).toBeNull();
  });

  test("a broken verdict is not an aborted round: count mismatch still returns null", () => {
    const events = history([[f("x")], [f("x")]]).map((e) => e.kind === "review" && e.data.round === 1 ? { ...e, data: { ...e.data, p1: 0 } } : e);
    expect(p1AnyStreak(events, 2)).toBeNull();
  });

  test("fallback termination record: the latest dispatched round without a verdict, none once it is reviewed", () => {
    const inFlight = history([[f("x")], null]);
    expect(openReviewRound(inFlight)).toEqual({ round: 2 });
    expect(openReviewRound(history([[f("x")], [f("x")]]))).toBeNull();
    // r2 was interrupted long ago, r3 reviewed: a fallback now has no open review to record
    expect(openReviewRound(history([[f("x")], null, [f("x")]]))).toBeNull();
    const recorded = [...history([[f("x")], [f("x")]], { dispatched: false }).filter((e) => e.kind !== "review" || e.data.round !== 1),
      ev("scheduler", { op: "fallback_manual", abortedReview: { round: 1 } })];
    expect([...abortedReviewRounds(recorded, 2)]).toEqual([1]);
  });
});

describe("RVH-1 fallback writes the termination record", () => {
  test("falling back with a dispatched review still open records its round; the next verdict's streak skips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "rvh1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const owner = { actor: "owner", now: 100 };
      createTask(db, owner, { project: "p", id: "T1", title: "rvh", kind: "code", agent: author.agent });
      setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
      for (const e of history([[f("x")], null]).filter((x) => x.kind !== "task" && x.data.op !== "fallback_manual" && x.data.op !== "workflow_resume")) {
        db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (200,?,'p','T1',?,'',?)").run(e.actor, e.kind, JSON.stringify(e.data));
      }
      fallbackToManual(db, { actor: "scheduler", now: 300 }, { taskId: "T1", reason: "fix_report：修复阶段缺上一轮完整审查报告" });
      const events = listEvents(db, { target: "T1" });
      expect(events.findLast((e) => e.data.op === "fallback_manual")?.data.abortedReview).toEqual({ round: 2 });
      expect([...abortedReviewRounds(events, 3)]).toEqual([2]);
    } finally {
      closeLedger(path);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
