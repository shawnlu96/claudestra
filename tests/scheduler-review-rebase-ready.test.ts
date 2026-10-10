/**
 * MCRY2 · a ready run whose moved head is refused a carry goes ready → await_review; that driver record hands the round in exactly
 * like the updating one (scheduler-review-rebase.ts): deliveredHead / currentRebase / the planner's fix diff answer to the PR's
 * net change against main. The updating path: tests/scheduler-review-rebase.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal, type ReviewCarry } from "../src/lib/scheduler-merge-driver.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { p1AnyStreak } from "../src/lib/scheduler-review.js";
import { fixDiffOf } from "../src/lib/review-converge-scope.js";
import { currentRebase, deliveredHead, movedHeadReceipt, rebaseDiff } from "../src/lib/scheduler-review-rebase.js";

const H = "a".repeat(40), N = "9".repeat(40);
const PR = "https://github.com/example/repo/pull/42";
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "review-session", taskId: "T1", family: "codex", source: "local" };
const reviewData = (round: number, head: string, p1: boolean) => ({ round, head, verdict: p1 ? "changes" : "pass", reviewer: reviewer.agent,
  reviewerSessionId: reviewer.sessionId, reviewerFamily: "codex", path: `reviews/T1-r${round}/report.md`, p0: 0, p1: p1 ? 1 : 0, p2: 0,
  findings: p1 ? [{ findingId: `f${round}`, family: "correctness", severity: "P1", probe: "[验收线 1] src/lib/x.ts:10 漏判" }] : [] });
const refused = (mp: string): ReviewCarry => ({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了", mainParent: mp, mainHead: mp });
type Db = ReturnType<typeof openLedger>;
const insert = (db: Db, actor: string, kind: string, data: Record<string, unknown>): number =>
  (db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (200,?,'p','T1',?,'',?) RETURNING seq")
    .get(actor, kind, JSON.stringify(data)) as { seq: number }).seq;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** Round `pass` passed at H (earlier rounds had a P1 elsewhere); the run, still at ready, finds the head at N and the carry refused. */
async function readyToReview(pass: number, mp: string) {
  const dir = mkdtempSync(join(tmpdir(), "mcry2-rb-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const owner = { actor: "owner", now: 100 };
  createTask(db, owner, { project: "p", id: "T1", title: "rebase", kind: "code", agent: author.agent });
  setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=?, rev=2, headSHA=?, pr=?, branch='task/T1' WHERE id='T1'").run(pass, H, PR);
  for (let r = 1; r <= pass; r++) {
    const head = r === pass ? H : "e".repeat(39) + r;
    insert(db, "agent-review", "stage", { from: r === 1 ? "build" : "fix", to: "review", round: r });
    insert(db, author.agent, "deliver", { round: r, headSHA: head });
    insert(db, "agent-review", "review", { ...reviewData(r, head, r !== pass), ...(r !== pass ? { findings: [{ findingId: `old-${r}`,
      family: "old", severity: "P1", probe: "[验收线 2] src/lib/old.ts:1 旧问题" }] } : {}) });
  }
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) VALUES ('merge-one','T1','p','merge_deploy','merge',3,4,2,1,?,2,'submitted','ready',100,100)`).run(H);
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-one',100)").run();
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
    templateVersion,status,reason,createdAt,updatedAt) VALUES ('review-create','T1','p','adversarial_review','ensure_session',1,2,1,1,?,2,'done','reviewer',100,100)`).run(H);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','review-session','codex','acp','active','review-create',100,100)`).run();
  const ctx = { actor: "scheduler", now: 150 };
  const { run } = beginMergeRun(db, ctx, "merge-one", ["check"]);
  const external: MergeExternal = {
    inspect: async () => ({ state: "OPEN", head: N, branch: "task/T1", base: "main", draft: false, crossRepository: false, mergeState: "CLEAN",
      mergeSha: null, checks: [{ name: "check", bucket: "pass" }] }),
    freshness: async () => ({ behindBy: 0, mainHead: mp }), carryReview: async () => refused(mp),
    updateBranch: async () => { throw new Error("no update"); }, merge: async () => { throw new Error("no merge"); },
  };
  await driveMerge(run, external, async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) =>
    advanceMergeRun(db, ctx, { intentId: "merge-one", from, to, rev, receipt, mergeSha, newHead }));
  expect(getMergeRun(db, "merge-one")!.phase).toBe("await_review");
  expect(getTask(db, "T1")).toMatchObject({ stage: "review", round: pass + 1, headSHA: N });
  return db;
}

/** Round `pass + 1` re-review at N with a P1, dispatched and acknowledged like the scheduler would; the planner's view. */
function reReviewed(db: Db, pass: number): PlannerSnapshot {
  const round = pass + 1;
  const intentSeq = insert(db, "scheduler", "note", { op: "dispatch-proxy" });
  const ackSeq = insert(db, "scheduler", "note", { op: "ack-proxy" });
  insert(db, "agent-review", "review", reviewData(round, N, true));
  const task = getTask(db, "T1")!;
  const sent: SchedulerIntent = { id: `review-r${round}`, taskId: "T1", project: "p", node: "adversarial_review", action: "review",
    recipient: reviewer.agent, causalSeq: intentSeq - 1, eventSeq: intentSeq, taskRev: task.rev, specRev: 1, head: N, templateVersion: 2,
    status: "done", attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 };
  return { task, workflow: getWorkflow(db, "T1"), events: listEvents(db, { project: "p", target: "T1" }), intents: [sent],
    blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [], workerCount: 0, maxWorkers: 2,
    freeWorkerSlot: "slot:p:0", author, reviewer, uiGate: { state: "none" }, screenshotsDigest: null,
    reviewDispatches: [{ intentId: `review-r${round}`, round, head: N, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq }] };
}

test("MCRY2 旧红新绿：ready 退回重审后 round 2 新 head P1 → planner 进 fix（不是 review_history）", async () => {
  const MP = "7".repeat(40);
  const s = reReviewed(await readyToReview(1, MP), 1);
  const review2 = s.events.findLast((e) => e.kind === "review")!;
  expect(deliveredHead(s.events, review2)).toBe(N);
  expect(currentRebase(2, s.events, N)).toMatchObject({ oldHead: H, newHead: N, mainParent: MP, round: 2 });
  expect(p1AnyStreak(s.events, 2)).toBe(1);
  const decision = planScheduler(s);
  expect(decision).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
  expect(JSON.stringify(decision)).not.toContain("review_history");
});

test("MCRY2 旧红新绿：ready 退回重审后 round 3 PR 自身文件上的 P1 不被 outside_diff 降级 → fix", async () => {
  const MP = "8".repeat(40);
  const db = await readyToReview(2, MP);
  const run = rebaseDiff.run, dirs = rebaseDiff.dirs;
  rebaseDiff.dirs = () => ["/fake"];
  rebaseDiff.run = (_, from, to) => from === MP && to === N ? ["src/lib/x.ts"] : null; // the PR against main
  cleanups.push(() => { rebaseDiff.run = run; rebaseDiff.dirs = dirs; });
  const probe = reReviewed(db, 2);
  // last head → new head only names the file main brought in
  const fixDiff = fixDiffOf(probe.task, probe.events, (_, from, to) => from === H && to === N ? ["src/lib/other-card.ts"] : null, ["/fake"]);
  expect(fixDiff).toEqual({ from: H, to: N, files: ["src/lib/x.ts"] });
  const decision = planScheduler({ ...probe, fixDiff });
  expect(decision).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
  expect(JSON.stringify(decision)).not.toContain("outside_diff");
});

test("MCRY2 反例：ready 记录不是调度器身份写的、或前一条不是同 head 的 merge → review stage，都不算交付", () => {
  const at = (seq: number, kind: LedgerEvent["kind"], actor: string, data: Record<string, unknown>): LedgerEvent =>
    ({ seq, kind, data, actor, ts: seq, project: "p", target: "T1", text: "", dedupKey: null });
  const receipt = movedHeadReceipt(H, N, refused("6".repeat(40)));
  const stage = at(10, "stage", "scheduler", { from: "merge", to: "review", round: 2, head: N });
  const phase = at(11, "scheduler", "scheduler", { op: "merge_phase", from: "ready", to: "await_review", receipt });
  const review = at(20, "review", "agent-review", reviewData(2, N, true));
  const base = [at(1, "deliver", author.agent, { round: 1, headSHA: H }), at(2, "review", "agent-review", reviewData(1, H, false))];
  expect(deliveredHead([...base, stage, phase, review], review)).toBe(N);
  const variants: LedgerEvent[][] = [
    [stage, { ...phase, actor: "owner" }],
    [{ ...stage, data: { ...stage.data, head: H } }, phase],
    [{ ...stage, data: { ...stage.data, from: "review", to: "fix" } }, phase],
    [{ ...stage, seq: 9 }, phase],
    [stage, { ...phase, data: { ...phase.data, from: "await_ci" } }],
  ];
  for (const v of variants) {
    expect(deliveredHead([...base, ...v, review], review)).toBe(H);
    expect(currentRebase(2, [...base, ...v], N)).toBeNull();
  }
});
