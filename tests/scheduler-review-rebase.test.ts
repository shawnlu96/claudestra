import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal, type PrSnapshot, type ReviewCarry } from "../src/lib/scheduler-merge-driver.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { p1AnyStreak } from "../src/lib/scheduler-review.js";
import { BASIS_LINE, convergeOrderLines, scopeLine } from "../src/lib/review-converge-order.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import { currentRebase, deliveredHead, movedHeadReceipt, rebaseDiff, rebaseScopeLines } from "../src/lib/scheduler-review-rebase.js";

const H = "a".repeat(40), N = "d".repeat(40), MP = "c".repeat(40);
const PR = "https://github.com/example/repo/pull/42";
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "review-session", taskId: "T1", family: "codex", source: "local" };
const reviewData = (round: number, head: string, findings: { findingId: string; family: string; severity: "P1" | "P2"; probe: string }[]) => ({
  round, head, verdict: findings.length ? "changes" : "pass", reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId,
  reviewerFamily: "codex", path: `reviews/T1-r${round}/report.md`, findings,
  p0: 0, p1: findings.filter((f) => f.severity === "P1").length, p2: findings.filter((f) => f.severity === "P2").length });
const P1 = { findingId: "net-diff", family: "correctness", severity: "P1" as const, probe: "[验收线 1] src/lib/x.ts:10 漏判" };
const REFUSED: ReviewCarry = { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: MP, mainHead: MP };
const snap = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: N, branch: "task/T1", base: "main", draft: false,
  crossRepository: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });
const insert = (db: ReturnType<typeof openLedger>, actor: string, kind: string, data: Record<string, unknown>, text = ""): number =>
  (db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (200,?,'p','T1',?,?,?) RETURNING seq")
    .get(actor, kind, text, JSON.stringify(data)) as { seq: number }).seq;

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** Round 1 delivered and passed at H, the merge run reached `updating`; the driver then finds update-branch moved the head to N. */
async function movedToReview(o: { actor?: string; carry?: ReviewCarry } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rh1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const owner = { actor: "owner", now: 100 };
  createTask(db, owner, { project: "p", id: "T1", title: "rebase", kind: "code", agent: author.agent });
  setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='task/T1' WHERE id='T1'").run(H, PR);
  insert(db, "agent-review", "stage", { from: "build", to: "review", round: 1 });
  insert(db, author.agent, "deliver", { round: 1, headSHA: H });
  insert(db, "agent-review", "review", reviewData(1, H, []));
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) VALUES ('merge-one','T1','p','merge_deploy','merge',3,4,2,1,?,2,'submitted','ready',100,100)`).run(H);
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-one',100)").run();
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) VALUES ('review-create','T1','p','adversarial_review','ensure_session',1,2,1,1,?,2,'done','reviewer',100,100)`).run(H);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','review-session','codex','acp','active','review-create',100,100)`).run();
  const ctx = { actor: o.actor ?? "scheduler", now: 150 };
  beginMergeRun(db, ctx, "merge-one", ["check"]);
  const updating = advanceMergeRun(db, ctx, { intentId: "merge-one", from: "ready", to: "updating", rev: 1 });
  const external: MergeExternal = {
    inspect: async () => snap(), freshness: async () => ({ behindBy: 0, mainHead: MP }),
    carryReview: async () => o.carry ?? REFUSED, updateBranch: async () => {}, merge: async () => { throw new Error("no merge"); },
  };
  const advance = async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) =>
    advanceMergeRun(db, ctx, { intentId: "merge-one", from, to, rev, receipt, mergeSha, newHead });
  await driveMerge(updating, external, advance);
  return { db, run: getMergeRun(db, "merge-one")! };
}

/** Round 2 re-review at N with a P1, dispatched and acknowledged like the scheduler would, then the planner's view. */
function reReviewed(db: ReturnType<typeof openLedger>): PlannerSnapshot {
  const intentSeq = insert(db, "scheduler", "note", { op: "dispatch-proxy" });
  const ackSeq = insert(db, "scheduler", "note", { op: "ack-proxy" });
  insert(db, "agent-review", "review", reviewData(2, N, [P1]));
  const task = getTask(db, "T1")!;
  const sent: SchedulerIntent = { id: "review-r2", taskId: "T1", project: "p", node: "adversarial_review", action: "review",
    recipient: reviewer.agent, causalSeq: intentSeq - 1, eventSeq: intentSeq, taskRev: task.rev, specRev: 1, head: N, templateVersion: 2,
    status: "done", attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 };
  return { task, workflow: getWorkflow(db, "T1"), events: listEvents(db, { project: "p", target: "T1" }), intents: [sent],
    blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [], workerCount: 0, maxWorkers: 2,
    freeWorkerSlot: "slot:p:0", author, reviewer, uiGate: { state: "none" }, screenshotsDigest: null,
    reviewDispatches: [{ intentId: "review-r2", round: 2, head: N, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq }] };
}

describe("i28-RH1 a merge-driver head move hands the round in like a deliver", () => {
  test("验收线 1: round 1 pass → movedHead back to review at N → round 2 P1 → planner goes to fix, no review_history", async () => {
    const { db, run } = await movedToReview();
    expect(run.phase).toBe("await_review");
    expect(getTask(db, "T1")).toMatchObject({ stage: "review", round: 2, headSHA: N });
    const s = reReviewed(db);
    const review2 = s.events.findLast((e) => e.kind === "review")!;
    expect(deliveredHead(s.events, review2)).toBe(N);
    expect(p1AnyStreak(s.events, 2)).toBe(1);
    const decision = planScheduler(s);
    expect(decision).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
    expect(JSON.stringify(decision)).not.toContain("review_history");
  });

  test("验收线 2: no driver record and a head that is not the last delivery still stops on review_history", async () => {
    // a PM / owner moving the same run writes the same receipt, but only the scheduler identity's record counts
    const byPm = await movedToReview({ actor: "owner" });
    expect(byPm.run.phase).toBe("await_review");
    expect(planScheduler(reReviewed(byPm.db))).toMatchObject({ kind: "escalate", code: "review_history" });
    // the head is not a merge of main (no main parent): old receipt wording, nothing recognized
    const noParent = await movedToReview({ carry: { ok: false, reason: "新 head 不是合并提交（父提交 1 个）" } });
    expect(noParent.run.reason).toContain("旧审查失效");
    expect(planScheduler(reReviewed(noParent.db))).toMatchObject({ kind: "escalate", code: "review_history" });
  });

  test("验收线 2: a look-alike receipt outside the driver's merge_phase / stage pair is not a delivery", () => {
    const at = (seq: number, kind: LedgerEvent["kind"], actor: string, data: Record<string, unknown>): LedgerEvent =>
      ({ seq, kind, data, actor, ts: seq, project: "p", target: "T1", text: "", dedupKey: null });
    const receipt = movedHeadReceipt(H, N, REFUSED);
    const stage = at(10, "stage", "scheduler", { from: "merge", to: "review", round: 2, head: N });
    const phase = at(11, "scheduler", "scheduler", { op: "merge_phase", from: "updating", to: "await_review", receipt });
    const review = at(20, "review", "agent-review", reviewData(2, N, [P1]));
    const base = [at(1, "deliver", author.agent, { round: 1, headSHA: H }), at(2, "review", "agent-review", reviewData(1, H, []))];
    expect(deliveredHead([...base, stage, phase, review], review)).toBe(N);
    const variants: LedgerEvent[][] = [
      [stage, { ...phase, kind: "note" }],
      [stage, { ...phase, data: { ...phase.data, to: "await_ci" } }],
      [{ ...stage, seq: 9 }, phase],
      [{ ...stage, data: { ...stage.data, head: H } }, phase],
      [{ ...stage, actor: "agent-pm" }, phase],
      [stage, { ...phase, data: { ...phase.data, receipt: `update-branch 改了 head：${N.slice(0, 12)}，x，旧审查失效` } }],
    ];
    for (const v of variants) expect(deliveredHead([...base, ...v, review], review)).toBe(H);
    // a record for another round does not cover this round's review either
    expect(deliveredHead([...base, { ...stage, data: { ...stage.data, round: 3 } }, phase, review], review)).toBeUndefined();
  });
});

describe("i28-RH1 the re-review order is scoped to the PR against main", () => {
  test("验收线 3: after movedHead the order's baseline is main, lists only the PR's files and says main's code is out of scope", async () => {
    // a real merge of main into the branch: main gained another card's file, the PR only touches its own
    const repo = mkdtempSync(join(tmpdir(), "rh1-git-"));
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "base.ts"), "0\n"); git("add", "."); git("commit", "-qm", "base");
    git("checkout", "-qb", "task");
    writeFileSync(join(repo, "pr-own.ts"), "1\n"); git("add", "."); git("commit", "-qm", "pr");
    const old = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "other-card.ts"), "2\n"); git("add", "."); git("commit", "-qm", "other card");
    const mainParent = git("rev-parse", "HEAD");
    git("checkout", "-q", "task"); git("merge", "-q", "--no-edit", "main");
    const moved = git("rev-parse", "HEAD");
    const dirs = rebaseDiff.dirs;
    rebaseDiff.dirs = () => [repo];
    cleanups.push(() => { rebaseDiff.dirs = dirs; });
    const at = (seq: number, kind: LedgerEvent["kind"], actor: string, data: Record<string, unknown>): LedgerEvent =>
      ({ seq, kind, data, actor, ts: seq, project: "p", target: "T1", text: "", dedupKey: null });
    const events = [at(1, "deliver", author.agent, { round: 2, headSHA: old }), at(2, "review", "agent-review", reviewData(2, old, [])),
      at(10, "stage", "scheduler", { from: "merge", to: "review", round: 3, head: moved }),
      at(11, "scheduler", "scheduler", { op: "merge_phase", from: "updating", to: "await_review",
        receipt: movedHeadReceipt(old, moved, { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent }) })];
    expect(currentRebase(3, events, moved)).toMatchObject({ oldHead: old, newHead: moved, mainParent, taskId: "T1" });
    const lines = convergeOrderLines(3, events, moved);
    expect(lines[0]).toBe(BASIS_LINE);
    expect(lines.join("\n")).not.toContain(`git diff ${old.slice(0, 12)}..`); // not "last reviewed head → new head"
    expect(lines[1]).toContain("比较基线是 main");
    expect(lines[1]).toContain(`git diff ${mainParent.slice(0, 12)}...${moved.slice(0, 12)}`);
    expect(lines[2]).toContain("合并 main 带进来的别卡代码不在范围内");
    expect(lines[2]).toContain("记 P2");
    expect(lines[3]).toBe("PR 自己的文件（1 个，相对 main）：\"pr-own.ts\"");
    expect(lines.join("\n")).not.toContain(moved); // order free text keeps short refs only
  });

  test("验收线 3: the local take_review order built from the ledger carries the same scope", async () => {
    const { db } = await movedToReview();
    const dirs = rebaseDiff.dirs, run = rebaseDiff.run;
    rebaseDiff.dirs = () => ["/fake"];
    rebaseDiff.run = (_, from, to) => from === MP && to === N ? ["src/lib/own.ts", "tests/own.test.ts"] : null;
    cleanups.push(() => { rebaseDiff.dirs = dirs; rebaseDiff.run = run; });
    const task = getTask(db, "T1")!;
    const built = reviewOrderOf(db, { task, orderId: "review-r2", node: "adversarial_review", head: N, auto: true }, "/tmp/rh1-reviews");
    if (!built.ok) throw new Error(built.error);
    const text = built.order.inputs.join("\n");
    expect(text).toContain("比较基线是 main");
    expect(text).toContain("PR 自己的文件（2 个，相对 main）：\"src/lib/own.ts\"、\"tests/own.test.ts\"");
    expect(text).toContain("合并 main 带进来的别卡代码不在范围内");
  });

  test("no checkout holds both commits: the order says so instead of guessing a list", () => {
    const run = rebaseDiff.run;
    rebaseDiff.run = () => null;
    cleanups.push(() => { rebaseDiff.run = run; });
    const at = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
      ({ seq, kind, data, actor: "scheduler", ts: seq, project: "p", target: "T9", text: "", dedupKey: null });
    const events = [at(10, "stage", { from: "merge", to: "review", round: 2, head: N }),
      at(11, "scheduler", { op: "merge_phase", from: "updating", to: "await_review", receipt: movedHeadReceipt(H, N, { ...REFUSED, mainParent: "e".repeat(40) }) })];
    expect(rebaseScopeLines(2, events, N)?.[2]).toContain("未能算出");
  });

  test("验收线 4: an ordinary fix round's order is what it was", () => {
    const at = (seq: number, kind: LedgerEvent["kind"], actor: string, data: Record<string, unknown>): LedgerEvent =>
      ({ seq, kind, data, actor, ts: seq, project: "p", target: "T1", text: "", dedupKey: null });
    const F = "f".repeat(40);
    const ordinary = [at(1, "deliver", author.agent, { round: 1, headSHA: H }), at(2, "review", "agent-review", reviewData(1, H, [P1])),
      at(3, "deliver", author.agent, { round: 2, headSHA: N }), at(4, "review", "agent-review", reviewData(2, N, [P1])),
      at(5, "deliver", author.agent, { round: 3, headSHA: F })];
    expect(convergeOrderLines(2, ordinary.slice(0, 3), N)).toEqual([BASIS_LINE]);
    expect(convergeOrderLines(3, ordinary, F)).toEqual([BASIS_LINE, scopeLine(3, ordinary, F)!]);
    // a fix delivered after a driver re-review is an ordinary round again
    const afterRebase = [...ordinary.slice(0, 2), at(10, "stage", "scheduler", { from: "merge", to: "review", round: 2, head: N }),
      at(11, "scheduler", "scheduler", { op: "merge_phase", from: "updating", to: "await_review", receipt: movedHeadReceipt(H, N, REFUSED) }),
      at(12, "review", "agent-review", reviewData(2, N, [P1])), at(13, "deliver", author.agent, { round: 3, headSHA: F })];
    expect(currentRebase(3, afterRebase, F)).toBeNull();
    expect(convergeOrderLines(3, afterRebase, F)).toEqual([BASIS_LINE, scopeLine(3, afterRebase, F)!]);
    expect(deliveredHead(afterRebase, at(14, "review", "agent-review", reviewData(3, F, [])))).toBe(F);
  });
});
