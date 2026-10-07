/**
 * MCRY6 · review-main-carry-send-source.ts: which source seq a run pinned, and that only the injected formal gate's answer at that seq
 * lets the merge go out. Fault injection only (a drifted seq, an off-head carry, a foreign carry, a throwing gate): none of these is a
 * reachable pool revocation; the reachable one (the owner withdrawing the MODELX exemption) is proved end to end in
 * tests/review-main-carry-auto-source-e2e.test.ts; that a manual_merge run keeps manualRunDrift instead, in the manual e2e next to it.
 */
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { LedgerError, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { ReviewProof } from "../src/lib/review-main-carry-manual-auto.js";
import { sendSourceRefusal } from "../src/lib/review-main-carry-send-source.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import type { ReviewFacts } from "../src/lib/scheduler-review.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), I = "i-merge-1";
let dirs: string[] = [], dbs: Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mcry6-")), db = openLedger(join(dir, "ledger.sqlite"));
  dirs.push(dir); dbs.push(db);
  const task = { id: "T1", project: "p", headSHA: B, round: 1, specRev: 1 } as LedgerTask;
  const run = { intentId: I, taskId: "T1", project: "p", reviewedHead: B, phase: "merging", beforeSend: true } as MergeRun;
  const ev = (data: Record<string, unknown>, actor = "scheduler", dedupKey?: string) =>
    insertEvent(db, { actor, now: Date.now(), ...(dedupKey ? { dedupKey } : {}) }, { project: "p", target: "T1", kind: "scheduler", text: "x", data }, !!dedupKey).seq;
  const ready = (head: string, reviewSeq: unknown = 7) => ev({ op: "merge_phase", intentId: I, phase: "ready", head, reviewSeq }, "agent-pm", `scheduler:${I}:merge:ready`);
  const carry = (from: string, to: string, over: Record<string, unknown> = {}, actor = "scheduler") =>
    ev({ op: "review_carry", intentId: I, from, to, round: 1, specRev: 1, sourceReviewSeq: 7, ...over }, actor, `scheduler:${I}:carry:${from}`);
  const seen: string[] = [];
  const gate = (seq: number | Error): ReviewProof => (_db, t) => { seen.push(t.headSHA as string); if (seq instanceof Error) throw seq; return { eventSeq: seq } as ReviewFacts; };
  const refusal = (proof: ReviewProof, r: MergeRun = run, t: LedgerTask = task) => sendSourceRefusal(db, r, t, {} as TaskWorkflow, proof);
  return { db, task, run, ready, carry, gate, refusal, seen };
}

test("no carry: the run's own ready event at this head pins the seq; the gate's same seq passes, another refuses", () => {
  const s = setup();
  s.ready(B);
  expect(s.refusal(s.gate(7))).toBeNull();
  expect(s.refusal(s.gate(9))).toBe("发出前重核正式来源不成立：正式来源是 #9，本 run 钉住的是 #7");
  expect(s.seen).toEqual([B, B]);
});

test("carries: only the last scheduler review_carry of this intent, ending on the run's head and this round / specRev, pins the seq", () => {
  const s = setup();
  s.ready(A, 5); // the begin seq is superseded once this intent carried
  s.carry(A, C, { sourceReviewSeq: 6 });
  s.carry(C, B);
  expect(s.refusal(s.gate(7))).toBeNull();
  expect(s.refusal(s.gate(6))).toMatch(/正式来源是 #6，本 run 钉住的是 #7/);
});

const unpinned: [string, (s: ReturnType<typeof setup>) => void][] = [
  ["no ready event at all", () => {}],
  ["the ready event is at another head", (s) => s.ready(A)],
  ["the ready event's reviewSeq is malformed", (s) => s.ready(B, "7")],
  ["the last carry ends on another head (a later carry never recorded)", (s) => { s.ready(A); s.carry(A, C); }],
  ["the last carry is another round", (s) => { s.ready(A); s.carry(A, B, { round: 2 }); }],
  ["the last carry is another specRev", (s) => { s.ready(A); s.carry(A, B, { specRev: 2 }); }],
  ["the last carry lost its source seq", (s) => { s.ready(A); s.carry(A, B, { sourceReviewSeq: null }); }],
  ["the last carry's source seq drifted (fault injection)", (s) => { s.ready(A); s.carry(A, B, { sourceReviewSeq: 8 }); }],
];
for (const [name, arrange] of unpinned) {
  test(`refuses, never searching an older PASS: ${name}`, () => {
    const s = setup();
    arrange(s);
    expect(s.refusal(s.gate(7))).toMatch(/^发出前重核正式来源不成立：/);
  });
}

test("a review_carry not written by the scheduler, or for another intent, is not this run's pin", () => {
  const s = setup();
  s.ready(B);
  s.carry(B, C, { sourceReviewSeq: 9 }, "agent-pm");
  s.carry(C, B, { intentId: "other", sourceReviewSeq: 9 });
  expect(s.refusal(s.gate(7))).toBeNull(); // still the ready pin at B
});

test("the formal gate throwing (exemption withdrawn, ticket / order broken) refuses with its own reason; nothing is swallowed as success", () => {
  const s = setup();
  s.ready(B);
  expect(s.refusal(s.gate(new LedgerError("conflict", "当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1")))).toBe(
    "发出前重核正式来源不成立（来源 / 家族 / 豁免已变）：当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
});

test("an unreadable ledger refuses instead of passing", () => {
  const s = setup();
  s.ready(B);
  s.db.close(); dbs.splice(0);
  expect(s.refusal(s.gate(7))).toMatch(/^发出前重核正式来源不成立/);
});
