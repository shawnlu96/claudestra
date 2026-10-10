import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, MAX_CI_REFRESHES, mergeRunDrift, type MergePhase } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";

const H = "a".repeat(40), N = "d".repeat(40), N2 = "c".repeat(40), MAIN = "e".repeat(40), DIFF = "9".repeat(64);
const SCHED = { actor: "scheduler", now: 200 };
/** MAINP2: the receipt carries its one-hop chain (review-main-carry-manual-auto.ts), which the merge step persists. */
const evidence = (oldHead: string, newHead: string) => carryReceipt({ oldHead, newHead, mainParent: MAIN, mainHead: MAIN, diffHash: DIFF })
  + carryChainSuffix([{ previousHead: oldHead, head: newHead, mainParent: MAIN }]);

/** A task sitting in `merge` with a passing cross-model review on H and an open merge run, as beginMergeRun requires. */
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "m9-carry-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const owner = { actor: "owner", now: 100 };
  createTask(db, owner, { project: "p", id: "T1", title: "carry", kind: "code", agent: "agent-author" });
  setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr='https://github.com/example/repo/pull/7', branch='task/T1' WHERE id='T1'").run(H);
  const verdict = { round: 1, head: H, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rv-1", reviewerFamily: "codex",
    path: "reviews/T1/report.md", findings: [], p0: 0, p1: 0, p2: 0 };
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-rv','p','T1','review','',?)").run(JSON.stringify(verdict));
  for (const [id, node, action, status] of [["rv-create", "adversarial_review", "ensure_session", "done"], ["mq", "merge_deploy", "merge", "submitted"]]) {
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,'T1','p',?,?,1,2,2,1,?,2,?,'x',100,100)`).run(id, node, action, H, status);
  }
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','mq',100)").run();
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-rv','rv-1','codex','acp','active','rv-create',100,100)`).run();
  beginMergeRun(db, SCHED, "mq", ["check"]);
  const step = (from: MergePhase, to: MergePhase, receipt?: string, newHead?: string, actor = "scheduler") =>
    advanceMergeRun(db, { actor, now: 200 }, { intentId: "mq", from, to, rev: getMergeRun(db, "mq")!.rev, receipt, newHead });
  const task = () => db.query("SELECT round, headSHA, specRev, rev FROM tasks WHERE id='T1'").get() as { round: number; headSHA: string; specRev: number; rev: number };
  const events = () => listEvents(db, { project: "p", target: "T1" });
  return { db, step, task, events, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

describe("i28-M9 journal: carrying a review onto the update-branch head", () => {
  test("scheduler carry re-pins run + task in one step, records evidence, and the review still reads as valid", () => {
    const f = ledger();
    try {
      f.step("ready", "updating");
      const before = f.task().rev;
      const run = f.step("updating", "await_ci", evidence(H, N), N);
      expect([run.phase, run.reviewedHead]).toEqual(["await_ci", N]);
      expect(f.task()).toMatchObject({ headSHA: N, rev: before + 1 });
      const carry = f.events().find((e) => e.data.op === "review_carry")!;
      expect(carry).toMatchObject({ actor: "scheduler", data: { from: H, to: N, mainHead: MAIN, mainParent: MAIN, diffHash: DIFF, round: 1, specRev: 1 } });
      const phase = f.events().find((e) => e.data.op === "merge_phase" && e.data.to === "await_ci")!;
      expect([phase.seq, phase.data.carrySeq]).toEqual([carry.seq + 1, carry.seq]);
      expect(currentReviewFacts(f.task(), f.events())).toMatchObject({ kind: "facts", facts: { head: H } });
      expect(mergeRunDrift(f.db, run)).toBeNull();
    } finally { f.close(); }
  });
  test("only the scheduler identity may carry; PM / owner / executor are refused and nothing changes", () => {
    const f = ledger();
    try {
      f.step("ready", "updating");
      for (const actor of ["owner", "agent-claudestra", "agent-author"]) {
        expect(() => f.step("updating", "await_ci", evidence(H, N), N, actor)).toThrow();
      }
      expect(f.task().headSHA).toBe(H);
      expect(getMergeRun(f.db, "mq")!.reviewedHead).toBe(H);
    } finally { f.close(); }
  });
  test.each([["no receipt", undefined], ["free text", "looks fine"], ["old head mismatch", evidence(N2, N)], ["new head mismatch", evidence(H, N2)]])(
    "carry with %s is invalid", (_, receipt) => {
      const f = ledger();
      try {
        f.step("ready", "updating");
        expect(() => f.step("updating", "await_ci", receipt, N)).toThrow();
        expect(f.task().headSHA).toBe(H);
      } finally { f.close(); }
    });
  test("main moving during CI: await_ci → updating is allowed 3 times, the 4th is refused; repeated phases do not collide", () => {
    const f = ledger();
    try {
      f.step("ready", "updating");
      let head = H;
      const heads = [N, N2, "1".repeat(40), "2".repeat(40)];
      for (let i = 0; i < MAX_CI_REFRESHES; i++) {
        f.step("updating", "await_ci", evidence(head, heads[i]!), heads[i]);
        head = heads[i]!;
        f.step("await_ci", "updating", "main 前进，重新更新");
      }
      f.step("updating", "await_ci", evidence(head, heads[3]!), heads[3]);
      expect(() => f.step("await_ci", "updating", "main 又前进")).toThrow(/前进 3 次/);
      expect(f.step("await_ci", "unknown", "放弃自动更新").phase).toBe("unknown");
      expect(currentReviewFacts(f.task(), f.events()).kind).toBe("facts"); // four links H→…→heads[3], all from the journal
    } finally { f.close(); }
  });
});

/** Pure chain checks: the events a real carry writes, then one tampered property per case. */
describe("i28-M9 review facts: a carry chain is the only way a review covers a new head", () => {
  const task = { round: 1, headSHA: N2, specRev: 1 };
  const ev = (seq: number, kind: string, data: Record<string, unknown>, actor = "scheduler"): LedgerEvent =>
    ({ seq, ts: seq, actor, project: "p", target: "T1", kind, text: "", data, dedupKey: null }) as LedgerEvent;
  const review = ev(1, "review", { round: 1, head: H, verdict: "pass", reviewer: "r", reviewerSessionId: "s", reviewerFamily: "codex",
    path: "x.md", findings: [], p0: 0, p1: 0, p2: 0 }, "r");
  const carry = (seq: number, from: string, to: string, extra: Record<string, unknown> = {}, actor = "scheduler") =>
    [ev(seq, "scheduler", { op: "review_carry", intentId: "mq", from, to, round: 1, specRev: 1, ...extra }, actor),
      ev(seq + 1, "scheduler", { op: "merge_phase", intentId: "mq", from: "updating", to: "await_ci", carrySeq: seq }, actor)];
  const good = [review, ...carry(10, H, N), ...carry(20, N, N2)];
  const read = (events: LedgerEvent[], t = task) => currentReviewFacts(t, events).kind;

  test("an unbroken scheduler chain from the review head to the task head is valid", () => {
    expect(read(good)).toBe("facts");
  });
  test.each([
    ["carry written by a PM", [review, ...carry(10, H, N), ...carry(20, N, N2, {}, "agent-claudestra")]],
    ["PM carry next to a genuine scheduler merge_phase", [review, ...carry(10, H, N), { ...carry(20, N, N2)[0]!, actor: "agent-claudestra" }, carry(20, N, N2)[1]!]],
    ["carry without its merge_phase in the same transaction", [review, ...carry(10, H, N), carry(20, N, N2)[0]!]],
    ["merge_phase not right after the carry", [review, ...carry(10, H, N), carry(20, N, N2)[0]!, { ...carry(20, N, N2)[1]!, seq: 23 }]],
    ["merge_phase pointing at another carry", [review, ...carry(10, H, N), carry(20, N, N2)[0]!, ev(21, "scheduler", { op: "merge_phase", intentId: "mq", to: "await_ci", carrySeq: 10 })]],
    ["broken link (second carry starts elsewhere)", [review, ...carry(10, H, N), ...carry(20, MAIN, N2)]],
    ["chain starts from a head the review never covered", [review, ...carry(10, MAIN, N), ...carry(20, N, N2)]],
    ["delivery after the carry", [...good, ev(30, "deliver", { headSHA: N2 }, "agent-author")]],
    ["delivery between review and carry", [review, ev(5, "deliver", { headSHA: H }, "agent-author"), ...carry(10, H, N), ...carry(20, N, N2)]],
    ["carry from another spec revision", [review, ...carry(10, H, N), ...carry(20, N, N2, { specRev: 2 })]],
    ["carry from another round", [review, ...carry(10, H, N, { round: 0 }), ...carry(20, N, N2)]],
    ["chain stops short of the task head", [review, ...carry(10, H, N)]],
    ["carry before the review", [...carry(-5, H, N), { ...review, seq: 0 }, ...carry(20, N, N2)]],
  ] as [string, LedgerEvent[]][])("%s → invalid", (_, events) => {
    expect(read(events)).toBe("invalid");
  });
  test("task head changed after the chain, or spec revision bumped → invalid", () => {
    expect(read(good, { ...task, headSHA: MAIN })).toBe("invalid");
    expect(read(good, { ...task, specRev: 2 })).toBe("invalid");
  });
  test("no carries: unchanged behaviour (same head valid, other head invalid)", () => {
    expect(read([review], { ...task, headSHA: H })).toBe("facts");
    expect(read([review])).toBe("invalid");
  });
});
