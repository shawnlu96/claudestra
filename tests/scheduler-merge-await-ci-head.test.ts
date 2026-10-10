/**
 * MCRY3 · await_ci meets a head the author pushed (PR812, 10-07): the run goes to await_review with the new head and the card back to
 * review; the queue never freezes. Anything else that changed (MERGED / CLOSED / base / branch / fork / draft) stays unknown, and so
 * does a run that already sent its merge. A train member leaving this way voids its train like any other drift, merging nobody.
 * Production wiring (real ledger CLI, fake gh): tests/scheduler-merge-await-ci-head-e2e.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, type MergeRun } from "../src/lib/scheduler-merge.js";
import { formTrain, stepTrain, type TrainDeps, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import { withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";

const OLD = "a".repeat(40), NEW = "c".repeat(40), MAIN = "e".repeat(40), MSHA = "b".repeat(40);
const PR = "https://github.com/example/repo/pull/42";
const SCHED = { actor: "scheduler" }, OWNER = { actor: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

/** Card T1 in merge, cross-family review passed at OLD, its merge run driven by the ledger to `phase` (await_ci or merging). */
function world(phase: "await_ci" | "merging" = "await_ci") {
  const dir = mkdtempSync(join(tmpdir(), "mcry3-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,'p','T1',?,'',?)").run(actor, kind, JSON.stringify(data));
  createTask(db, OWNER, { project: "p", id: "T1", title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='task/T1' WHERE id='T1'").run(OLD, PR);
  add("owner", "stage", { from: "build", to: "review", round: 1 });
  const wf = () => (db.query("SELECT rev FROM task_workflows WHERE taskId='T1'").get() as { rev: number }).rev;
  const rev = () => getTask(db, "T1")!.rev;
  planIntent(db, SCHED, { id: "rv", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "adversarial_review",
    action: "review", reason: "review", recipient: "agent-review" });
  settleIntent(db, SCHED, { id: "rv", from: "pending", to: "submitted", receipt: "ack" });
  add("agent-review", "review", { round: 1, head: OLD, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs",
    reviewerFamily: "codex", path: "report.md", findings: [], p0: 0, p1: 0, p2: 0 });
  settleIntent(db, SCHED, { id: "rv", from: "submitted", to: "done", receipt: "review event recorded" });
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','rs','codex','acp','active','rv',10,10)`).run();
  db.query("UPDATE tasks SET stage='merge' WHERE id='T1'").run();
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  planIntent(db, SCHED, { id: "a0", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "merge_deploy",
    action: "merge", reason: "merge", resources: ["merge:p"] });
  settleIntent(db, SCHED, { id: "a0", from: "pending", to: "submitted", receipt: "merge controller claimed" });
  beginMergeRun(db, SCHED, "a0", ["check"]);
  const step = (to: MergeRun["phase"], receipt: string) => { const r = getMergeRun(db, "a0")!; advanceMergeRun(db, SCHED, { intentId: "a0", from: r.phase, to, rev: r.rev, receipt }); };
  step("await_ci", `PR ${OLD.slice(0, 12)} 可合并，等待 CI`);
  if (phase === "merging") step("merging", "CI 全绿：check");
  const calls: string[] = [];
  const drive = async (snap: Partial<PrSnapshot>) => {
    const pr: PrSnapshot = { state: "OPEN", head: NEW, branch: "task/T1", base: "main", draft: false, crossRepository: false,
      mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "check", bucket: "pending" }], ...snap };
    const external: MergeExternal = {
      inspect: async () => { calls.push("inspect"); return pr; }, freshness: async () => { calls.push("freshness"); return { behindBy: 0, mainHead: MAIN }; },
      carryReview: async () => { calls.push("carry"); return { ok: false, reason: "不该问" }; },
      updateBranch: async () => { calls.push("update"); }, merge: async () => { calls.push("merge"); return MSHA; },
      train: async () => { calls.push("train"); return null; },
    };
    return driveMerge(getMergeRun(db, "a0")!, external, async (from, to, r, receipt, mergeSha, newHead) =>
      advanceMergeRun(db, SCHED, { intentId: "a0", from, to, rev: r, receipt, mergeSha, newHead }));
  };
  const state = () => ({ run: getMergeRun(db, "a0")!.phase, frozen: getMeta(db, "p").queueFrozen.frozen, stage: getTask(db, "T1")!.stage,
    head: getTask(db, "T1")!.headSHA, intent: getIntent(db, "a0")!.status });
  return { db, drive, state, calls };
}

test("MCRY3: await_ci + the author's new head on the same open PR → await_review with the new head, card back to review, queue not frozen", async () => {
  for (const snap of [{}, { mergeState: "CLEAN", checks: [{ name: "check", bucket: "pass" as const }] }, { mergeState: "BLOCKED" },
    { mergeState: "UNKNOWN" }, { mergeState: "BEHIND" }, { mergeState: "DIRTY" }, { checks: [{ name: "check", bucket: "fail" as const }] }]) {
    const w = world();
    expect(await w.drive(snap)).toMatchObject({ phase: "await_review" });
    expect(w.state()).toEqual({ run: "await_review", frozen: false, stage: "review", head: NEW, intent: "cancelled" });
    expect(getMergeRun(w.db, "a0")?.reason).toBe(`等 CI 时作者推了新 head：原 head ${OLD} → 新 head ${NEW}，旧审查失效`);
    // nothing carried, nothing sent, the train never asked: the old review is void for the author's commit
    expect(w.calls).toEqual(["inspect"]);
    expect(listEvents(w.db, { project: "p", target: "T1" }).some((e) => e.data.op === "review_carry")).toBe(false);
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE intentId='a0'").get()).toEqual({ n: 0 }); // the merge slot is free
  }
});

test("MCRY3 反例：MERGED / CLOSED / base / branch / fork / draft (UNSTABLE or not) with the new head → unknown and frozen, as before", async () => {
  for (const snap of [{ state: "MERGED" as const, mergeSha: MSHA }, { state: "CLOSED" as const }, { base: "dev" }, { branch: "task/T9" },
    { crossRepository: true }, { draft: true }, { draft: true, mergeState: "CLEAN" }, { draft: true, mergeState: "UNKNOWN" }]) {
    const w = world();
    expect([JSON.stringify(snap), (await w.drive(snap)).phase]).toEqual([JSON.stringify(snap), "unknown"]);
    expect(w.state()).toMatchObject({ frozen: true, stage: "merge", head: OLD });
    expect(w.calls.filter((c) => c === "merge" || c === "update")).toEqual([]);
  }
});

test("MCRY3 反例：this run already claimed merging (the merge may have been sent) + a new head → unknown, never back to review", async () => {
  const w = world("merging");
  expect((await w.drive({})).phase).toBe("unknown");
  expect(w.state()).toMatchObject({ frozen: true, stage: "merge", head: OLD });
  expect(w.calls).toEqual(["inspect"]);
});

test("MCRY3 反例：the same head at await_ci keeps the existing gates (UNSTABLE pending waits, red required CI bounces to fix)", async () => {
  const wait = world();
  expect((await wait.drive({ head: OLD })).phase).toBe("await_ci");
  const red = world();
  expect((await red.drive({ head: OLD, checks: [{ name: "check", bucket: "fail" }] })).phase).toBe("resolved");
  expect(red.state()).toMatchObject({ stage: "fix", frozen: false });
});

// ── merge train: one member's head moves while the train is testing ──
const sha = (n: number) => n.toString(16).padStart(40, "0");
test("MCRY3 列车：列车在测、一个成员 head 被作者改了 → 该成员回 review，列车按现有漂移逻辑作废，谁也不合并、不冻结", async () => {
  const prs = new Map([[`${PR}1`, sha(1)], [`${PR}2`, sha(2)]]), calls: string[] = [];
  const branches = new Map<string, string[]>();
  let pending = true;
  const gh: TrainGh = {
    mainHead: async () => MAIN, prFiles: async (pr) => [pr.endsWith("1") ? "a.ts" : "b.ts"], prHead: async (pr) => prs.get(pr)!,
    createBranch: async (_r, b) => { branches.set(b, []); }, mergeInto: async (_r, b, h) => { branches.get(b)!.push(h); return "merged"; },
    openDraft: async () => 1000, checks: async () => [{ name: "check", bucket: pending ? "pending" : "pass" }], failLog: async () => "",
    parents: async () => [sha(99)], mergeMatchHead: async (pr) => { calls.push(`match-head:${pr}`); return sha(77); },
    closePr: async (_r, n) => { calls.push(`close:${n}`); }, deleteBranch: async (_r, b) => { branches.delete(b); },
  };
  let state: TrainState | null = null;
  const store: TrainStore = { load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); }, event: () => {}, nextSeq: () => 1 };
  const gone = new Set<string>();
  const deps: TrainDeps = { gh, store, now: () => 1_000, requiredChecks: ["check"], notify: async () => {},
    memberStatus: (id) => (gone.has(id) ? { kind: "gone", why: "回 review" } : { kind: "waiting" }) };
  const cards = [1, 2].map((i) => ({ taskId: `T${i}`, prRef: `${PR}${i}`, head: sha(i) }));
  await formTrain("p", cards, deps);
  await stepTrain(store.load("p")!, deps); // assembled, CI running
  expect(store.load("p")).toMatchObject({ phase: "testing" });
  // T1's merge run sits in await_ci (its train is testing); the author pushes a fix to PR 1
  prs.set(`${PR}1`, NEW);
  let row: MergeRun = { intentId: "m-T1", taskId: "T1", project: "p", prRef: `${PR}1`, expectedBranch: "task/T1", reviewedHead: sha(1),
    requiredChecks: "check", phase: "await_ci", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
  const external = withMergeTrain({
    inspect: async (pr) => ({ state: "OPEN", head: prs.get(pr)!, branch: "task/T1", base: "main", draft: false, crossRepository: false,
      mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }] }),
    freshness: async () => ({ behindBy: 0, mainHead: MAIN }), carryReview: async () => ({ ok: false, reason: "-" }),
    updateBranch: async () => { calls.push("update"); }, merge: async () => { calls.push("merge"); return MSHA; },
  }, { gh, store });
  const journal: string[] = [];
  await driveMerge(row, external, async (from, to, rev, receipt, _m, newHead) => {
    journal.push(`${from}→${to}@${newHead?.slice(0, 4)}`);
    row = { ...row, phase: to, rev: rev + 1, reason: receipt ?? null };
    return row;
  });
  expect(journal).toEqual([`await_ci→await_review@${NEW.slice(0, 4)}`]);
  gone.add("T1"); // the ledger now has T1 in review (memberStatusOf reads the task stage)
  pending = false;
  const after = await stepTrain(store.load("p")!, deps);
  expect(after).toMatchObject({ phase: "cleanup", outcome: "void" });
  expect(after.reason).toMatch(/T1/);
  await stepTrain(store.load("p")!, deps);
  expect(store.load("p")).toMatchObject({ phase: "done", outcome: "void", merged: [] });
  expect(calls.filter((c) => !c.startsWith("close:"))).toEqual([]); // no match-head, no serial merge, no update-branch
});
