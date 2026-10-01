/**
 * i28-N11: the merge gate accepts this round's pooled reviewer (a peer's done lend order), which never writes a
 * scheduler_sessions row; a card reviewed only locally keeps the old behaviour.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { beginMergeRun } from "../src/lib/scheduler-merge.js";

const H = "a".repeat(40), OLD = "c".repeat(40);
const ORDER = "lend:T1:s1:r1:a0", POOL_INTENT = "pool-review";
const POOL_AGENT = "peer:sekai", POOL_SESSION = `lend:sekai:${ORDER}`;

interface Shape {
  local?: { agent: string; sessionId: string; family: string } | null;
  order?: { status?: string; round?: number; head?: string; family?: string } | null;
  verdict?: { reviewer: string; sessionId: string; family: string; round?: number; p1?: number };
}

function fixture(shape: Shape) {
  const dir = mkdtempSync(join(tmpdir(), "n11-merge-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id: "T1", title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, ctx, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='task/T1' WHERE id='T1'").run(H, "https://github.com/example/repo/pull/42");
  const intent = (id: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,
    causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt) VALUES (?,'T1','p',?,?,1,2,2,1,?,2,?,'r',100,100)`)
    .run(id, node, action, H, status);
  intent("merge-one", "merge_deploy", "merge", "submitted");
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-one',100)").run();
  if (shape.local) {
    intent("review-create", "adversarial_review", "ensure_session", "done");
    db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES ('T1','reviewer',?,?,?,'acp','active','review-create',100,100)`).run(shape.local.agent, shape.local.sessionId, shape.local.family);
  }
  if (shape.order) {
    const o = shape.order;
    intent(POOL_INTENT, "adversarial_review", "review", "done");
    db.query(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,leaseMs,createdBy,createdAt,updatedAt)
      VALUES (?,'T1','p','sekai',?,'review',1,?,?,'example/repo','{}','x','x',?,60000,'scheduler',100,100)`)
      .run(ORDER, o.family ?? "codex", o.round ?? 1, o.head ?? H, o.status ?? "done");
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (100,'scheduler','p','T1','scheduler','',?,?)")
      .run(JSON.stringify({ op: "pool", id: POOL_INTENT, orderId: ORDER }), `scheduler:${POOL_INTENT}:pool`);
  }
  const v = shape.verdict;
  if (v) {
    const p1 = v.p1 ?? 0;
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (101,?,'p','T1','review','',?)").run(v.reviewer, JSON.stringify({
      round: v.round ?? 1, head: H, verdict: p1 ? "changes" : "pass", reviewer: v.reviewer, reviewerSessionId: v.sessionId, reviewerFamily: v.family,
      path: "reviews/T1-r1/report.md", p0: 0, p1, p2: 0,
      findings: p1 ? [{ findingId: "F1", family: "x", severity: "P1", probe: "p", summary: "s" }] : [] }));
  }
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, close, begin: () => beginMergeRun(db, { actor: "scheduler", now: 102 }, "merge-one", ["check"]) };
}

const pooledVerdict = { reviewer: POOL_AGENT, sessionId: POOL_SESSION, family: "codex" };
const run = (shape: Shape, check: (begin: () => unknown) => void) => {
  const f = fixture(shape);
  try { check(f.begin); } finally { f.close(); }
};

describe("i28-N11 merge gate accepts the pooled reviewer", () => {
  test("N10 shape: no reviewer row, done codex pool order this round/head, claude author, pass → begins", () => {
    run({ order: {}, verdict: pooledVerdict }, (begin) => expect(begin()).toMatchObject({ run: { phase: "ready", reviewedHead: H } }));
  });
  test("earlier round reviewed locally, this round pooled → this round's pool reviewer is used", () => {
    run({ local: { agent: "agent-review", sessionId: "review-session", family: "codex" }, order: {}, verdict: pooledVerdict },
      (begin) => expect(begin()).toMatchObject({ run: { phase: "ready" } }));
  });
  for (const [why, order] of [["order not done", { status: "claimed" }], ["head differs", { head: OLD }], ["round differs", { round: 0 }]] as const) {
    test(`pool order ${why} → still refused`, () => {
      run({ order, verdict: pooledVerdict }, (begin) => expect(begin).toThrow(/缺同卡跨模型审查/));
    });
  }
  test("pooled reviewer of the author's family → refused", () => {
    run({ order: { family: "claude" }, verdict: { ...pooledVerdict, family: "claude" } }, (begin) => expect(begin).toThrow(/缺同卡跨模型审查/));
  });
  test("pooled verdict with P1 → refused", () => {
    run({ order: {}, verdict: { ...pooledVerdict, p1: 1 } }, (begin) => expect(begin).toThrow(/缺同卡跨模型审查/));
  });
  test("verdict from someone other than the pooled reviewer → refused", () => {
    run({ order: {}, verdict: { ...pooledVerdict, sessionId: "lend:sekai:other-order" } }, (begin) => expect(begin).toThrow(/缺同卡跨模型审查/));
  });
  test("local-only card: unchanged (matching local reviewer begins, mismatching one refused, no reviewer refused)", () => {
    const local = { agent: "agent-review", sessionId: "review-session", family: "codex" };
    run({ local, verdict: { reviewer: local.agent, sessionId: local.sessionId, family: "codex" } },
      (begin) => expect(begin()).toMatchObject({ run: { phase: "ready" } }));
    run({ local, verdict: pooledVerdict }, (begin) => expect(begin).toThrow(/缺同卡跨模型审查/));
    run({ verdict: { reviewer: local.agent, sessionId: local.sessionId, family: "codex" } }, (begin) => expect(begin).toThrow(/缺同卡跨模型审查/));
  });
});
