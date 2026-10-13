/**
 * merge-arch-REVIEW1 · content-identity review carry on a temp ledger: driver carries → recordContentCarry → currentReviewFacts and the
 * gates that read it (merge run recheck, mergeCandidates, merge review proof, planner). Mode is injected through setContentModePort.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { mergeContentReviewMode, recordContentCarry } from "../src/lib/merge-content-review.js";
import { MERGE_ARCH_OBSERVE_OP, MERGE_CONTENT_REVIEW_OP, setContentModePort, unsentAware } from "../src/lib/merge-content-review-read.js";
import type { ContentCarry } from "../src/lib/merge-content-review-sink.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { bindContentCarrySink, managerContentSink, noteContentCarry, setContentCarrySink } from "../src/lib/merge-content-review-sink.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeReviewProof, mergeRunDrift, type MergePhase } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal, type PrSnapshot, type ReviewCarry } from "../src/lib/scheduler-merge-driver.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import { runLedger } from "../src/manager/ledger.js";
import { mergeCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";

const H = "a".repeat(40), N = "b".repeat(40), N2 = "c".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40), DIFF = "9".repeat(64);
const SCHED = { actor: "scheduler", now: 300 };
let mode: RecoveryMode = "on";
setContentModePort(() => mode);
afterEach(() => { mode = "on"; setContentModePort(() => mode); setContentCarrySink(null); });

const hop = (previousHead: string, head: string, mainParent: string) => ({ previousHead, head, mainParent });
const carry = (oldHead: string, newHead: string, extra: Partial<ContentCarry> = {}): ContentCarry => ({ project: "p", taskId: "T1", ok: true,
  reason: "净 diff 一致", oldHead, newHead, mainParent: oldHead === H ? M1 : M2, mainHead: oldHead === H ? M1 : M2, diffHash: DIFF,
  chain: [hop(oldHead, newHead, oldHead === H ? M1 : M2)], ...extra });

/** T1 in `merge` on H, a cross-model PASS on H with a real report file, a submitted merge intent with its run at ready. */
function world(review: Record<string, unknown> = {}, merge = Object.keys(review).length === 0) {
  const dir = mkdtempSync(join(tmpdir(), "merge-content-review-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const report = join(dir, "report.md");
  writeFileSync(report, "## 通过\n");
  const owner = { actor: "owner", now: 100 };
  createTask(db, owner, { project: "p", id: "T1", title: "carry", kind: "code", agent: "agent-author" });
  setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr='https://github.com/o/r/pull/7', branch='task/T1' WHERE id='T1'").run(H);
  const verdict = { round: 1, head: H, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rv-1", reviewerFamily: "codex", path: report,
    findings: [], p0: 0, p1: 0, p2: 0, ...review };
  const reviewSeq = Number(db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-rv','p','T1','review','',?)")
    .run(JSON.stringify(verdict)).lastInsertRowid);
  for (const [id, node, action, status] of [["rv-create", "adversarial_review", "ensure_session", "done"], ["mq", "merge_deploy", "merge", "submitted"]]) {
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,'T1','p',?,?,1,2,2,1,?,2,?,'x',100,100)`).run(id, node, action, H, status);
  }
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','mq',100)").run();
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-rv','rv-1','codex','acp','active','rv-create',100,100)`).run();
  if (merge) beginMergeRun(db, SCHED, "mq", ["check"]); // a run begins only on a passing cross-model review
  const task = () => getTask(db, "T1")!;
  const events = () => listEvents(db, { project: "p", target: "T1" });
  /** The PR head moved by something other than the driver's own carry step (no review_carry is written). */
  const moveHead = (to: string) => {
    db.query("UPDATE tasks SET headSHA=?, rev=rev+1 WHERE id='T1'").run(to);
    db.query("UPDATE scheduler_merges SET reviewedHead=? WHERE intentId='mq'").run(to);
  };
  const facts = () => currentReviewFacts(task(), events());
  return { db, reviewSeq, report, task, events, moveHead, facts, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}
type World = ReturnType<typeof world>;
const ops = (w: World, op: string) => w.events().filter((e) => e.data.op === op);
const run = (w: World) => getMergeRun(w.db, "mq")!;

describe("[验收线 1] two pure-main updates keep citing the original review", () => {
  test("on: H→N→N2 each projected by explicit seq; facts stay on the source review's own head", () => {
    const w = world();
    try {
      w.moveHead(N);
      expect(w.facts()).toEqual({ kind: "invalid", reason: "审查结论的完整 head 与任务不一致" }); // red without a projection
      const first = recordContentCarry(w.db, SCHED, carry(H, N));
      expect(first).toMatchObject({ outcome: "projected", duplicate: false });
      expect(w.facts()).toMatchObject({ kind: "facts", facts: { head: H, reviewer: "agent-rv", eventSeq: w.reviewSeq } });
      const second = recordContentCarry(w.db, SCHED, carry(N, N2));
      expect(second).toMatchObject({ outcome: "projected" });
      w.moveHead(N2);
      expect(w.facts()).toMatchObject({ kind: "facts", facts: { head: H, eventSeq: w.reviewSeq } });
      const [a, b] = ops(w, MERGE_CONTENT_REVIEW_OP);
      expect([a!.data.sourceReviewSeq, b!.data.sourceReviewSeq, a!.data.hops, b!.data.hops]).toEqual([w.reviewSeq, w.reviewSeq, 1, 2]);
      expect((b!.data.evidence as { chain: unknown[] }).chain).toEqual([hop(H, N, M1), hop(N, N2, M2)]);
      expect(recordContentCarry(w.db, SCHED, carry(N, N2))).toMatchObject({ outcome: "projected", duplicate: true });
      expect(ops(w, MERGE_CONTENT_REVIEW_OP)).toHaveLength(2);
    } finally { w.close(); }
  });
  test("observe: records merge_arch_observe with the candidate result; currentReviewFacts is byte-identical to before", () => {
    const w = world();
    try {
      mode = "observe";
      w.moveHead(N);
      const before = JSON.stringify(w.facts());
      const r = recordContentCarry(w.db, SCHED, carry(H, N));
      expect(r).toMatchObject({ outcome: "observed", carry: true, hops: 1, recorded: true });
      expect(recordContentCarry(w.db, SCHED, carry(H, N))).toMatchObject({ outcome: "observed", recorded: false });
      expect(ops(w, MERGE_ARCH_OBSERVE_OP)).toHaveLength(1);
      expect(ops(w, MERGE_CONTENT_REVIEW_OP)).toHaveLength(0);
      expect(JSON.stringify(w.facts())).toBe(before);
    } finally { w.close(); }
  });
  test("off: nothing is read or written; facts unchanged", () => {
    const w = world();
    try {
      mode = "off";
      w.moveHead(N);
      const before = JSON.stringify(w.facts()), count = w.events().length;
      expect(recordContentCarry(w.db, SCHED, carry(H, N))).toEqual({ outcome: "skipped", reason: "mergeContentReview 是 off" });
      expect(w.events()).toHaveLength(count);
      expect(JSON.stringify(w.facts())).toBe(before);
    } finally { w.close(); }
  });
  test("policy: unset key = observe even under project mode on; explicit key wins; broken file = off; key listed once", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcr-policy-")), path = join(dir, "recovery-policy.json");
    try {
      expect(mergeContentReviewMode("p", path)).toBe("observe");
      writeFileSync(path, JSON.stringify({ projects: { p: { mode: "on" } } }));
      expect(mergeContentReviewMode("p", path)).toBe("observe");
      writeFileSync(path, JSON.stringify({ projects: { p: { mode: "observe", keys: { mergeContentReview: "on" } } } }));
      expect(mergeContentReviewMode("p", path)).toBe("on");
      writeFileSync(path, "{");
      expect(mergeContentReviewMode("p", path)).toBe("off");
      expect(RECOVERY_KEYS.filter((k) => k === "mergeContentReview")).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("[验收线 2] any change refuses and keeps the old path", () => {
  const refused = (w: World, c: ContentCarry, why: RegExp) => {
    expect(recordContentCarry(w.db, SCHED, c)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(why) });
    expect(ops(w, MERGE_CONTENT_REVIEW_OP)).toHaveLength(0);
  };
  test("driver could not prove a pure-main update (manual push / conflict edit / rebase)", () => {
    const w = world();
    try { refused(w, carry(H, N, { ok: false, reason: "新 head 不是合并提交" }), /新 head 不是合并提交/); } finally { w.close(); }
  });
  test("net diff changed between hops", () => {
    const w = world();
    try {
      recordContentCarry(w.db, SCHED, carry(H, N));
      expect(recordContentCarry(w.db, SCHED, carry(N, N2, { diffHash: "8".repeat(64) }))).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/净 diff/) });
    } finally { w.close(); }
  });
  test("chain not starting at the source review head and no trusted earlier hop", () => {
    const w = world();
    try { refused(w, carry(N, N2), /沿用起点/); } finally { w.close(); }
  });
  test("delivery after the review / report missing / open P1 / P0 / same-family reviewer", () => {
    const cases: [Record<string, unknown>, (w: World) => void, RegExp][] = [
      [{}, (w) => w.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'agent-author','p','T1','deliver','','{}')").run(), /交付/],
      [{}, (w) => rmSync(w.report), /报告不存在/],
      [{ verdict: "changes", findings: [{ findingId: "f1", family: "x", severity: "P1", probe: "p" }], p1: 1 }, () => {}, /P0 \/ P1/],
      [{ verdict: "block", findings: [{ findingId: "f0", family: "x", severity: "P0", probe: "p" }], p0: 1 }, () => {}, /P0 \/ P1/],
      [{ reviewerFamily: "claude" }, () => {}, /跨模型/],
    ];
    for (const [review, mutate, why] of cases) {
      const w = world(review);
      try { mutate(w); refused(w, carry(H, N), why); } finally { w.close(); }
    }
  });
  test("after projecting: specRev bump, new round, new review, or a delivery invalidate it", () => {
    const bumps: ((w: World) => void)[] = [
      (w) => w.db.query("UPDATE tasks SET specRev=2 WHERE id='T1'").run(),
      (w) => w.db.query("UPDATE tasks SET round=2 WHERE id='T1'").run(),
      (w) => w.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (400,'agent-rv','p','T1','review','',?)`)
        .run(JSON.stringify({ round: 1, head: H, verdict: "pass", reviewer: "agent-rv2", reviewerSessionId: "rv-2", reviewerFamily: "codex",
          path: w.report, findings: [], p0: 0, p1: 0, p2: 0 })),
      (w) => w.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (400,'agent-author','p','T1','deliver','','{}')").run(),
    ];
    for (const bump of bumps) {
      const w = world();
      try {
        recordContentCarry(w.db, SCHED, carry(H, N));
        w.moveHead(N);
        expect(w.facts().kind).toBe("facts");
        bump(w);
        expect(w.facts().kind).not.toBe("facts");
      } finally { w.close(); }
    }
  });
  test("source report removed after projecting: facts, run recheck and mergeCandidates all stop carrying", () => {
    const w = world();
    try {
      expect(recordContentCarry(w.db, SCHED, carry(H, N))).toMatchObject({ outcome: "projected" });
      w.moveHead(N);
      expect(w.facts().kind).toBe("facts");
      rmSync(w.report);
      expect(w.facts().kind).toBe("invalid");
      expect(mergeRunDrift(w.db, run(w))).toMatch(/审查结论已不合格/);
      expect(mergeCandidates(w.db, "p", null)).toEqual([]);
    } finally { w.close(); }
  });
  test("spec changed after the source review but before the write: refused, never rebound to the new spec", () => {
    const changes: ((w: World) => void)[] = [
      (w) => w.db.query("UPDATE tasks SET specRev=2 WHERE id='T1'").run(), // row only, no event
      (w) => { // recorded: a move to spec revision 2 after the review
        w.db.query("UPDATE tasks SET specRev=2 WHERE id='T1'").run();
        w.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'owner','p','T1','stage','',?)")
          .run(JSON.stringify({ from: "review", to: "spec", round: 1, specRev: 2 }));
      },
      (w) => w.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'owner','p','T1','stage','',?)")
        .run(JSON.stringify({ from: "review", to: "spec", round: 1, specRev: 2 })), // row still on 1, but a later event records 2
    ];
    for (const change of changes) {
      const w = world();
      try {
        change(w);
        refused(w, carry(H, N), /规格/);
        mode = "observe";
        expect(recordContentCarry(w.db, SCHED, carry(H, N))).toMatchObject({ outcome: "observed", carry: false });
        mode = "on";
        w.moveHead(N);
        expect(w.facts().kind).not.toBe("facts");
      } finally { w.close(); }
    }
  });
  test("observe records refusals too (with the reason) and never projects", () => {
    const w = world({ reviewerFamily: "claude" });
    try {
      mode = "observe";
      expect(recordContentCarry(w.db, SCHED, carry(H, N))).toMatchObject({ outcome: "observed", carry: false, reason: expect.stringMatching(/跨模型/) });
      expect(ops(w, MERGE_ARCH_OBSERVE_OP)[0]!.data).toMatchObject({ carry: false, hops: 0, sourceReviewSeq: w.reviewSeq });
    } finally { w.close(); }
  });
  test("only the scheduler identity writes", () => {
    const w = world();
    try {
      for (const actor of ["owner", "agent-claudestra", "agent-author"]) expect(() => recordContentCarry(w.db, { actor, now: 300 }, carry(H, N))).toThrow(/调度服务/);
    } finally { w.close(); }
  });
});

describe("[验收线 3] coexistence: merge recheck, mergeCandidates, merge review proof read the same projection", () => {
  test("projection on → run recheck clean, candidate listed, proof returns the source review; off → all refuse as before", () => {
    const w = world();
    try {
      w.moveHead(N);
      const wf = getWorkflow(w.db, "T1")!;
      expect(mergeRunDrift(w.db, run(w))).toMatch(/审查结论已不合格/);
      expect(mergeCandidates(w.db, "p", null)).toEqual([]);
      expect(() => mergeReviewProof(w.db, w.task(), wf)).toThrow();
      recordContentCarry(w.db, SCHED, carry(H, N));
      expect(mergeRunDrift(w.db, run(w))).toBeNull();
      expect(mergeCandidates(w.db, "p", null)).toEqual([{ taskId: "T1", prRef: "https://github.com/o/r/pull/7", head: N }]);
      expect(mergeReviewProof(w.db, w.task(), wf)).toMatchObject({ eventSeq: w.reviewSeq, head: H });
      mode = "observe";
      expect(mergeRunDrift(w.db, run(w))).toMatch(/审查结论已不合格/);
      expect(mergeCandidates(w.db, "p", null)).toEqual([]);
    } finally { w.close(); }
  });
});

describe("[验收线 4] switching mode never turns an old projection into new authority", () => {
  test("on → off before the merge is sent: invalid; a run that already claimed merging keeps reading it (verified, not re-sent)", () => {
    const w = world();
    try {
      recordContentCarry(w.db, SCHED, carry(H, N));
      w.moveHead(N);
      mode = "off";
      expect(w.facts().kind).toBe("invalid");
      w.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (500,'scheduler','p','T1','scheduler','',?)`)
        .run(JSON.stringify({ op: "merge_phase", intentId: "mq", from: "await_ci", to: "merging" }));
      expect(w.facts().kind).toBe("facts");
      expect(ops(w, MERGE_CONTENT_REVIEW_OP)).toHaveLength(1);
    } finally { w.close(); }
  });
  test("only this card's latest run, still merging (or merged after its claim), verifies; an older / other / given-up claim restores nothing", () => {
    const w = world();
    try {
      recordContentCarry(w.db, SCHED, carry(H, N));
      w.moveHead(N);
      mode = "off";
      const phase = (intentId: string, from: string, to: string) => w.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
        VALUES (500,'scheduler','p','T1','scheduler','',?)`).run(JSON.stringify({ op: "merge_phase", intentId, from, to }));
      phase("old", "await_ci", "merging");
      phase("old", "merging", "unknown"); // that run gave up: its claim is history
      expect(w.facts().kind).toBe("invalid");
      phase("mq", "ready", "await_ci"); // another run's later phase, no claim of its own
      expect(w.facts().kind).toBe("invalid");
      phase("mq", "await_ci", "merging");
      expect(w.facts().kind).toBe("facts");
      expect(unsentAware((r: { intentId: string; beforeSend?: true }) => w.facts().kind)({ intentId: "mq", beforeSend: true })).toBe("invalid");
      expect(unsentAware((r: { intentId: string; beforeSend?: true }) => w.facts().kind)({ intentId: "other", beforeSend: true })).toBe("facts");
      expect(w.facts().kind).toBe("facts"); // the mark ends with the read
      phase("mq", "merging", "merged");
      expect(w.facts().kind).toBe("facts");
    } finally { w.close(); }
  });
  test("no mode port (a process that never loaded the writer) reads off", () => {
    const w = world();
    try {
      recordContentCarry(w.db, SCHED, carry(H, N));
      w.moveHead(N);
      setContentModePort(null);
      expect(w.facts().kind).toBe("invalid");
    } finally { w.close(); }
  });
});

/** The real driver on run `mq` at `updating`: GitHub shows head N, carryReview answers `proof`; ledger writes are in-process. */
async function driveTo(w: World, proof: ReviewCarry) {
  const advance = async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) =>
    advanceMergeRun(w.db, SCHED, { intentId: "mq", from, to, rev, receipt, mergeSha, newHead });
  await advance("ready", "updating", run(w).rev);
  const pr: PrSnapshot = { state: "OPEN", head: N, branch: "task/T1", crossRepository: false, base: "main", draft: false, mergeState: "CLEAN", mergeSha: null,
    checks: [{ name: "check", bucket: "pending" }] };
  const external = { inspect: async () => pr, carryReview: async () => proof } as unknown as MergeExternal;
  return driveMerge(run(w), external, advance, () => {}, (m) => mergeRunDrift(w.db, m));
}
const proved: ReviewCarry = { ok: true, reason: "净 diff 一致", mainParent: M1, mainHead: M1, diffHash: DIFF, chain: [hop(H, N, M1)] };
const inProcess = (w: World) => setContentCarrySink(async (c) => { recordContentCarry(w.db, SCHED, c); });

describe("[验收线 3] wiring: driver hook, service sink, existing carry pairs untouched", () => {
  test("driver: the projection is written before the carry step, so review_carry / merge_phase stay adjacent", async () => {
    const w = world();
    try {
      inProcess(w);
      expect((await driveTo(w, proved)).phase).toBe("await_ci");
      const [p] = ops(w, MERGE_CONTENT_REVIEW_OP), c = ops(w, "review_carry")[0]!;
      const phase = w.events().find((e) => e.data.op === "merge_phase" && e.data.carrySeq === c.seq)!;
      expect([p!.seq < c.seq, phase.seq]).toEqual([true, c.seq + 1]);
      expect(w.facts()).toMatchObject({ kind: "facts", facts: { head: H, eventSeq: w.reviewSeq } });
      mode = "off"; // the engine carry alone still holds: the old path is not routed through the projection
      expect(w.facts()).toMatchObject({ kind: "facts" });
    } finally { w.close(); }
  });
  test("driver: an unproved head move goes back to review as before; observe notes the refusal", async () => {
    const w = world();
    try {
      mode = "observe";
      inProcess(w);
      expect((await driveTo(w, { ok: false, reason: "新 head 不是合并提交" })).phase).toBe("await_review");
      expect(ops(w, MERGE_ARCH_OBSERVE_OP).map((e) => e.data)).toEqual([expect.objectContaining({ carry: false, reason: "新 head 不是合并提交" })]);
    } finally { w.close(); }
  });
  test("service sink: off never starts the child; observe calls `ledger scheduler-content-review` once; errors are logged, a stop is not", async () => {
    const calls: string[][] = [];
    const sink = managerContentSink(async (...args) => { calls.push(args); return { ok: true }; });
    const saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; // the test-guard's temp state dir
    setContentCarrySink(sink);
    const off = JSON.stringify({ projects: { p: { keys: { mergeContentReview: "off" } } } });
    try {
      writeFileSync(RECOVERY_POLICY_PATH, off);
      await noteContentCarry({ project: "p", taskId: "T1", reviewedHead: H }, N, proved);
      expect(calls).toHaveLength(0);
      writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: {} }));
      await noteContentCarry({ project: "p", taskId: "T1", reviewedHead: H }, N, proved);
    } finally { if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true }); else writeFileSync(RECOVERY_POLICY_PATH, saved); }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 4)).toEqual(["ledger", "scheduler-content-review", "T1", "--carry"]);
    expect(JSON.parse(calls[0]![4]!)).toMatchObject({ ok: true, oldHead: H, newHead: N, diffHash: DIFF });
    const errors: string[] = [], log = console.error;
    console.error = (m: string) => { errors.push(m); };
    try {
      setContentCarrySink(async () => { throw new Error("child failed"); });
      await noteContentCarry({ project: "p", taskId: "T1", reviewedHead: H }, N, proved);
      expect(errors.join()).toMatch(/child failed/);
      setContentCarrySink(async () => { throw new SchedulerStopped("stop"); });
      await expect(noteContentCarry({ project: "p", taskId: "T1", reviewedHead: H }, N, proved)).rejects.toBeInstanceOf(SchedulerStopped);
    } finally { console.error = log; }
  });
  test("CLI `ledger scheduler-content-review`: scheduler only, shape-checked, records through the same writer", async () => {
    const w = world();
    try {
      const deps = (actor: string) => ({ db: w.db, actor, registryPath: join(tmpdir(), "none.json"), projectIds: ["p"], now: () => 300,
        loadRegistry: async () => ({ agents: {} }), saveRegistry: async () => {} }) as unknown as LedgerDeps;
      const body = JSON.stringify({ ...carry(H, N), project: undefined, taskId: undefined });
      expect(await runLedger(["scheduler-content-review", "T1", "--carry", body], deps("agent-author"))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await runLedger(["scheduler-content-review", "T1", "--carry", "{}"], deps("scheduler"))).toMatchObject({ ok: false, code: "invalid" });
      expect(await runLedger(["scheduler-content-review", "T1", "--carry", body], deps("scheduler"))).toMatchObject({ ok: true, outcome: "projected" });
      expect(ops(w, MERGE_CONTENT_REVIEW_OP)).toHaveLength(1);
    } finally { w.close(); }
  });
  test("tick-scoped sink: cleared when the tick's scope ends; a lost lease stops before any ledger child", async () => {
    const calls: string[][] = [], manager = async (...args: string[]) => { calls.push(args); return { ok: true }; };
    const note = () => noteContentCarry({ project: "p", taskId: "T1", reviewedHead: H }, N, proved);
    { using _bound = bindContentCarrySink(manager, () => { throw new SchedulerStopped("lease lost"); }); await expect(note()).rejects.toBeInstanceOf(SchedulerStopped); }
    { using _bound = bindContentCarrySink(manager, () => {}); await note(); }
    await note(); // after the scope: no sink, no call
    expect(calls).toHaveLength(1);
  });
  test("planner: merge stage reads the same projection (no 'missing review' once projected)", () => {
    const w = world();
    try {
      for (const t of ["scheduler_merges", "scheduler_resources"]) w.db.query(`DELETE FROM ${t} WHERE intentId='mq'`).run(); // no merge planned yet
      w.db.query("DELETE FROM scheduler_intents WHERE id='mq'").run();
      w.moveHead(N);
      const plan = () => planScheduler(autoSnapshot(w.db, w.task(), { registry: [], maxWorkers: 2 }));
      expect(plan()).toMatchObject({ code: "merge_review_missing" });
      recordContentCarry(w.db, SCHED, carry(H, N));
      expect(plan()).not.toMatchObject({ code: "merge_review_missing" });
      mode = "observe";
      expect(plan()).toMatchObject({ code: "merge_review_missing" });
    } finally { w.close(); }
  });
});

/** A real run begun at N on the H→N projection, driven from await_ci through the claim; `afterClaim` runs right after `merging` commits. */
async function sendFromAwaitCi(afterClaim: () => void) {
  const w = world({}, false);
  let sent = 0;
  try {
    w.moveHead(N);
    w.db.query("UPDATE scheduler_intents SET head=?, taskRev=(SELECT rev FROM tasks WHERE id='T1') WHERE id='mq'").run(N);
    recordContentCarry(w.db, SCHED, carry(H, N));
    beginMergeRun(w.db, SCHED, "mq", ["check"]);
    const advance = async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
      const r = advanceMergeRun(w.db, SCHED, { intentId: "mq", from, to, rev, receipt, mergeSha, newHead });
      if (to === "merging") afterClaim();
      return r;
    };
    await advance("ready", "await_ci", run(w).rev, "CI 待跑");
    const open: PrSnapshot = { state: "OPEN", head: N, branch: "task/T1", crossRepository: false, base: "main", draft: false, mergeState: "CLEAN",
      mergeSha: null, checks: [{ name: "check", bucket: "pass" }] };
    const external = {
      inspect: async () => sent ? { ...open, state: "MERGED", mergeSha: M2 } : open,
      freshness: async () => ({ behindBy: 0, mainHead: M1 }),
      merge: async () => { sent++; return M2; },
    } as unknown as MergeExternal;
    const end = await driveMerge(run(w), external, advance, () => {}, unsentAware((m) => mergeRunDrift(w.db, m)));
    return { sent, phase: end.phase, reason: end.reason };
  } finally { w.close(); }
}

describe("[验收线 4] a switch between the merging claim and the merge API sends nothing (real driver, service recheck wrapper)", () => {
  test("on throughout: the projection authorizes the send (control)", async () => {
    expect(await sendFromAwaitCi(() => {})).toMatchObject({ sent: 1, phase: "merged" });
  });
  for (const to of ["off", "observe"] as const) {
    test(`on → ${to} after the claim, before the API: refused, not sent`, async () => {
      const r = await sendFromAwaitCi(() => { mode = to; });
      expect(r.sent).toBe(0);
      expect(r.phase).not.toBe("merged");
      expect(r.reason).toMatch(/审查结论已不合格/);
    });
  }
});
