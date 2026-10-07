/**
 * MCRY2 · ledger side: from=ready, `scheduler-merge-step --to await_ci --new-head` carries only on the previous attempt's own
 * update-branch, re-read from the ledger inside the write transaction (scheduler-merge-ready-carry.ts). Any missing piece is a
 * conflict with zero writes; the driver then goes to await_review (a refused carry never freezes the queue).
 * The PMDIR1 shape end to end, with the real CLI / git / fake gh: tests/scheduler-merge-ready-carry.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { resumeAutoWorkflow } from "../src/lib/ledger-scheduler-resume.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setFrozen } from "../src/lib/ledger-write.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, resolveMergeRun, type MergeRun } from "../src/lib/scheduler-merge.js";
import { readyCarryRefusal } from "../src/lib/scheduler-merge-ready-carry.js";

const OLD = "a".repeat(40), NEW = "c".repeat(40), MAINP = "d".repeat(40), MAIN = "e".repeat(40), DIFF = "f".repeat(64);
const PR = "https://github.com/example/repo/pull/42";
const SCHED = { actor: "scheduler" }, OWNER = { actor: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Prior = "updating" | "ready_only" | "merged" | "done" | "pm_updating";
/**
 * Card T1 in merge, round 1, reviewed at OLD. a0 runs to `prior` (default: ready → updating → unknown, PM resolves cancelled),
 * the PM unfreezes and hands back, the scheduler plans a1 and begins it at ready.
 */
function world(prior: Prior = "updating", outcome: "cancelled" | "failed" | "done" = "cancelled") {
  const dir = mkdtempSync(join(tmpdir(), "mcry2-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
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
  const merge = (id: string) => {
    planIntent(db, SCHED, { id, taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "merge_deploy",
      action: "merge", reason: "merge", resources: ["merge:p"] });
    settleIntent(db, SCHED, { id, from: "pending", to: "submitted", receipt: "merge controller claimed" });
    return beginMergeRun(db, SCHED, id, ["check"]).run;
  };
  const step = (id: string, to: MergeRun["phase"], extra: { receipt?: string; newHead?: string; mergeSha?: string } = {}, ctx = SCHED) => {
    const r = getMergeRun(db, id)!;
    return advanceMergeRun(db, ctx, { intentId: id, from: r.phase, to, rev: r.rev, ...extra });
  };
  merge("a0");
  if (prior === "updating") step("a0", "updating");
  if (prior === "pm_updating") step("a0", "updating", {}, OWNER); // a PM's own step: not the scheduler's update-branch
  if (prior === "merged") { step("a0", "updating"); step("a0", "await_ci", { receipt: "head 未变，等待 CI" }); step("a0", "merging", { receipt: "CI 全绿" }); }
  step("a0", "unknown", { receipt: "外部步骤失败：gh pr checks 无结果" });
  resolveMergeRun(db, OWNER, { intentId: "a0", outcome: prior === "merged" ? "failed" : outcome, receipt: "PR OPEN，未合并" });
  setFrozen(db, OWNER, { project: "p", frozen: false, reason: "核对无其他 unknown" });
  resumeAutoWorkflow(db, OWNER, { taskId: "T1", taskRev: rev(), workflowRev: wf(), reason: "交回 auto", maxWorkers: 2 });
  const a1 = () => merge("a1");
  const receipt = (hops = 1) => {
    const chain = Array.from({ length: hops }, (_, i) => ({ previousHead: i ? String(i).padStart(40, "1") : OLD,
      head: i === hops - 1 ? NEW : String(i + 1).padStart(40, "1"), mainParent: MAINP }));
    return carryReceipt({ oldHead: OLD, newHead: NEW, mainParent: MAINP, mainHead: MAIN, diffHash: DIFF }) + carryChainSuffix(chain);
  };
  const carry = (hops = 1, ctx = SCHED) => step("a1", "await_ci", { receipt: receipt(hops), newHead: NEW }, ctx);
  const writes = () => ({ events: listEvents(db, { project: "p" }).length, task: getTask(db, "T1"), run: getMergeRun(db, "a1") });
  return { db, add, a1, carry, step, writes };
}

test("MCRY2 ledger: the previous attempt's own ready → updating, cancelled, same round/spec → review_carry with priorIntent, await_ci", () => {
  for (const outcome of ["cancelled", "failed"] as const) {
    const w = world("updating", outcome);
    w.a1();
    expect(w.carry()).toMatchObject({ phase: "await_ci", reviewedHead: NEW });
    expect(getTask(w.db, "T1")).toMatchObject({ headSHA: NEW, stage: "merge" });
    const carry = listEvents(w.db, { project: "p" }).findLast((e) => e.data.op === "review_carry")!;
    expect(carry).toMatchObject({ actor: "scheduler", data: { intentId: "a1", priorIntent: "a0", from: OLD, to: NEW, round: 1, specRev: 1 } });
    expect(getMeta(w.db, "p").queueFrozen.frozen).toBe(false);
  }
});

const refusals: [string, () => ReturnType<typeof world>, RegExp][] = [
  ["上一次尝试没走到 updating（PR 上的合 main 是别人推的）", () => world("ready_only"), /没有由调度器从 ready 发出 update-branch/],
  ["ready → updating 是 PM 自己推的，不是调度器", () => world("pm_updating"), /没有由调度器从 ready 发出 update-branch/],
  ["上一次尝试结清为 done", () => world("updating", "done"), /未合并/],
  ["上一次尝试已发出合并（merging）", () => world("merged"), /未合并/],
];
for (const [name, make, why] of refusals) {
  test(`MCRY2 ledger refuses (conflict, zero writes): ${name}`, () => {
    const w = make();
    try { w.a1(); } catch (e) {
      // a merged attempt is never retried: the planner's write gate refuses a1 already; the carry check refuses it too
      expect((e as Error).message).toMatch(/自动重试禁用/);
      const a0 = getIntent(w.db, "a0")!, current = { ...a0, id: "a1", causalSeq: 1e9, eventSeq: 1e9 };
      expect(readyCarryRefusal({ task: { id: "T1", round: 1, specRev: 1 }, current, reviewedHead: OLD,
        events: listEvents(w.db, { project: "p", target: "T1" }), prior: { intent: a0, run: getMergeRun(w.db, "a0") } })).toMatch(why);
      return;
    }
    const before = w.writes();
    expect(() => w.carry()).toThrow(why);
    expect(w.writes()).toEqual(before);
  });
}

test("MCRY2 ledger refuses: a deliver or a stage event after the previous attempt", () => {
  for (const kind of ["deliver", "stage"]) {
    const w = world();
    w.a1();
    w.add("agent-author", kind, kind === "stage" ? { from: "merge", to: "merge", round: 1 } : { headSHA: NEW });
    const before = w.writes();
    expect(() => w.carry()).toThrow(/之后卡上有交付或阶段变化/);
    expect(w.writes()).toEqual(before);
  }
});

test("MCRY2 ledger refuses: round or specRev of the previous attempt differs", () => {
  const w = world();
  w.a1();
  w.db.query("UPDATE scheduler_intents SET specRev=0 WHERE id='a0'").run();
  const before = w.writes();
  expect(() => w.carry()).toThrow(/轮次或规格版本/);
  expect(w.writes()).toEqual(before);
  w.db.query("UPDATE scheduler_intents SET specRev=1 WHERE id='a0'").run();
  // a0 planned inside another round's merge stage (events are append-only, so the facts are fed to the pure check directly)
  const facts = (round: number) => ({ task: { id: "T1", round: 1, specRev: 1 }, current: getIntent(w.db, "a1")!, reviewedHead: OLD,
    events: listEvents(w.db, { project: "p", target: "T1" }).map((e) => e.kind === "stage" && e.data.to === "merge" ? { ...e, data: { ...e.data, round } } : e),
    prior: { intent: getIntent(w.db, "a0")!, run: getMergeRun(w.db, "a0") } });
  expect(readyCarryRefusal(facts(1))).toBeNull();
  expect(readyCarryRefusal(facts(2))).toMatch(/轮次或规格版本/);
});

test("MCRY2 ledger refuses: 2 hops while mainCarry is not on everywhere, 17 hops ever", () => {
  for (const hops of [2, 17]) {
    const w = world();
    w.a1();
    const before = w.writes();
    expect(() => w.carry(hops)).toThrow(hops === 2 ? /mainCarry 策略不是 on/ : /要 1\.\.16 跳/);
    expect(w.writes()).toEqual(before);
  }
});

test("MCRY2 ledger refuses: a non-scheduler identity cannot write the carry; the driver's word on the prior intent is never read", () => {
  const w = world();
  w.a1();
  const before = w.writes();
  expect(() => w.carry(1, OWNER)).toThrow(/只许调度服务身份写/);
  expect(w.writes()).toEqual(before);
  // a forged "priorIntent" in the receipt is not evidence: the ledger re-reads the intents itself and still names a0
  w.db.query("UPDATE scheduler_merges SET reviewedHead=? WHERE intentId='a0'").run(NEW); // a0 never reviewed OLD → refused
  expect(() => w.carry()).toThrow(/审查的 head 不是本次/);
  expect(w.writes()).toEqual(before);
});

test("MCRY2 ledger: a refused ready carry falls back to await_review (card back to review, queue not frozen)", () => {
  const w = world("ready_only");
  w.a1();
  expect(w.step("a1", "await_review", { receipt: "update-branch 改了 head：x，旧审查失效", newHead: NEW })).toMatchObject({ phase: "await_review" });
  expect(getTask(w.db, "T1")).toMatchObject({ stage: "review", headSHA: NEW });
  expect(getMeta(w.db, "p").queueFrozen.frozen).toBe(false);
});

// Driver unit: what ready does with each PR snapshot, the ledger stubbed.
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: NEW, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });
const run0: MergeRun = { intentId: "a1", taskId: "T1", project: "p", prRef: PR, expectedBranch: "task/T1", reviewedHead: OLD, requiredChecks: "check",
  phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
async function drive(snap: PrSnapshot, ledger: "ok" | "refuse" = "ok", carryOk = true) {
  let row = run0;
  const journal: string[] = [];
  const external: MergeExternal = {
    inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: MAIN }),
    carryReview: async () => carryOk ? { ok: true, reason: "纯 main", mainParent: MAINP, mainHead: MAIN, diffHash: DIFF,
      chain: [{ previousHead: OLD, head: NEW, mainParent: MAINP }] } : { ok: false, reason: "带非 main 改动", mainParent: MAINP },
    updateBranch: async () => { throw new Error("no update at ready"); }, merge: async () => { throw new Error("no merge"); },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, _sha?: string, newHead?: string) => {
    journal.push(`${from}→${to}${newHead ? `@${newHead.slice(0, 1)}` : ""}`);
    if (to === "await_ci" && newHead && ledger === "refuse") throw new Error("advance merge run: 跨尝试沿用不成立：上一次尝试没有由调度器从 ready 发出 update-branch");
    row = { ...row, phase: to, rev: rev + 1, reason: receipt ?? null, reviewedHead: to === "await_ci" && newHead ? newHead : row.reviewedHead };
    return row;
  };
  await driveMerge(run0, external, advance);
  return { phase: row.phase, journal, reason: row.reason };
}

test("MCRY2 driver at ready: moved head → carry (await_ci) / ledger refusal or non-main change → await_review; MERGED / base / branch / fork → unknown", async () => {
  expect(await drive(pr())).toMatchObject({ phase: "await_ci", journal: ["ready→await_ci@c"] });
  expect(await drive(pr({ mergeState: "BEHIND" }))).toMatchObject({ phase: "await_ci" }); // main moved again: await_ci refreshes after the carry
  const refused = await drive(pr(), "refuse");
  expect(refused).toMatchObject({ phase: "await_review", journal: ["ready→await_ci@c", "ready→await_review@c"] });
  expect(refused.reason).toContain("跨尝试沿用被台账拒绝");
  expect(await drive(pr(), "ok", false)).toMatchObject({ phase: "await_review", journal: ["ready→await_review@c"] });
  for (const change of [{ state: "MERGED" as const }, { state: "CLOSED" as const }, { base: "dev" }, { branch: "task/T9" }, { crossRepository: true }]) {
    expect(await drive(pr(change))).toMatchObject({ phase: "unknown", journal: ["ready→unknown"] });
  }
});
