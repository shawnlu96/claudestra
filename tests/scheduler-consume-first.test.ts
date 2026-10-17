/**
 * AUTOSTARVE1 · results already in are consumed before the auto loop's order: a pooled card whose order is done / cancelled
 * is settled (and a stage move it unlocks is made) in the same pass even when 13 merge cards ahead of it use up the budget.
 * Real ledger and CLI (the i28-R9 pool path); the budget is a passPace clock that is spent before the first card.
 * Key off = the old order: the card waits behind the merges (the pre-fix red). Pure order: consumeFirstOrder.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { saveRawResult } from "../src/lib/pool-review-proof-raw.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { consumeFirstOrder, type LiveIntent } from "../src/lib/scheduler-consume-first.js";
import { passPace } from "../src/lib/scheduler-yield.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { B_WORKER, lendSide } from "./pool-review-proof-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const MERGES = Array.from({ length: 13 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);

describe("consumeFirstOrder (pure)", () => {
  const intent = (over: Partial<LiveIntent> = {}): LiveIntent => ({ id: "i", status: "submitted", action: "review", eventSeq: 10, ...over });
  const cards = ["A", "B", "C", "D", "E", "F", "G", "H"].map((taskId) => ({ taskId }));
  test("terminal order or a newer deliver / review → consumed, in input order; unknown / merge / settled intents keep the old rules", () => {
    const live = new Map<string, LiveIntent | null>([["A", intent()], ["B", intent({ status: "pending" })], ["C", intent()], ["D", intent()],
      ["E", intent({ status: "unknown" })], ["F", intent({ action: "merge", status: "pending" })], ["G", null], ["H", intent()]]);
    const orders = new Map<string, string | null>([["A", "claimed"], ["B", "cancelled"], ["C", "done"], ["D", "unknown"], ["E", "done"], ["F", null],
      ["G", null], ["H", "released"]]);
    const seq = new Map<string, number | null>([["A", 11], ["D", 99], ["F", 99], ["G", 99]]);
    expect(consumeFirstOrder(cards, live, orders, seq).map((c) => c.taskId)).toEqual(["A", "B", "C", "H"]);
    expect(consumeFirstOrder(cards, live, new Map(), new Map([["A", 10]])).map((c) => c.taskId)).toEqual([]); // an event the intent already saw
  });
});

/** T1 pooled for review (mate's Codex), plus 13 auto merge cards that mergeFirst puts ahead of it. */
async function starved() {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-"))), b = lendSide(f.dir);
  const lend = { borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => reports, writeReport: (p: string, x: string) => writeFileSync(p, x), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      saveRaw: (text: string) => saveRawResult(join(f.dir, "lend-raw"), text), pinnedKey: async () => b.pinned } };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const policy = { maxActiveWorkers: 0, remote: REMOTE };
  const run = (key: RecoveryPolicyPort | undefined, pace?: ReturnType<ReturnType<typeof passPace>["phase"]>) => schedulerAutoTick(f.db, { p: policy },
    { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow, ...(key ? { recoveryPolicy: key } : {}) }, pace);
  await toBuild(f);
  await run(undefined); // write order
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  expect((await run(undefined)).cards[0]).toMatchObject({ step: "pool_pooled" });
  for (const id of MERGES) {
    createTask(f.db, f.at("owner"), { project: "p", id, title: "merge", kind: "code" });
    setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
    f.db.run("UPDATE tasks SET stage = 'merge' WHERE id = ?", [id]);
    f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,'p','merge_deploy','merge',1,1,1,1,?,2,'submitted','seed',300,300)`).run(`m-${id}`, id, "c".repeat(40));
  }
  /** Every clock reading is 5 ms later and the budget is 1 ms: the pass is past its budget before its first card (13 merges' worth). */
  const spent = () => { let t = 1_000_000; return passPace({}, { budgetMs: 1, now: () => (t += 5) }).phase(); };
  const order = () => listLendOrders(f.db, "T1")[0]!;
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  const answer = async () => {
    const claimed = await peer("claim", { v: 1, orderId: order().orderId, worker: B_WORKER });
    expect(claimed.ok).toBe(true);
    return (await b.answer(claimed as never, { verdict: "pass" }, (body) => peer("write", body))).r;
  };
  return { f, run, spent, order, answer };
}

const keyOff: RecoveryPolicyPort = (project, k) => k === "autoConsumeFirst" ? { mode: "off", manualAfterMs: null, source: "config" } : recoveryPolicy(project, k);
const t1 = (cards: { taskId: string; step: string; detail: string }[]) => cards.filter((c) => c.taskId === "T1").map((c) => [c.step, c.detail]);

describe("AUTOSTARVE1 on a real ledger, 13 merge cards using up the budget", () => {
  test("[验收线 1] the review card whose lend order is done is settled and moves review→merge this pass; key off = old red", async () => {
    const s = await starved();
    try {
      expect(await s.answer()).toMatchObject({ ok: true });
      expect(s.order().status).toBe("done");
      const old = await s.run(keyOff, s.spent());
      expect(old.cards.map((c) => c.taskId)).toEqual(["M01"]); // the one card past the budget is the first merge in rotation
      expect([s.f.intents().find((i) => i.recipient === "peer:mate")?.status, s.f.task().stage]).toEqual(["pending", "review"]);
      const r = await s.run(undefined, s.spent());
      expect(r.failed).toEqual([]);
      expect(t1(r.cards)).toEqual([["pool_done", expect.any(String)], ["stage", "review→merge"]]);
      expect(r.cards.map((c) => c.taskId)).toEqual(["T1", "T1", "M01"]); // the auto loop keeps its own order behind the group, T1 not again
      expect(s.f.task().stage).toBe("merge");
    } finally { s.f.close(); }
  });

  test("[验收线 2] a pooled order withdrawn (cancelled) settles its intent this pass; placement then follows the old rules", async () => {
    const s = await starved();
    try {
      s.f.db.run("UPDATE lend_orders SET status = 'cancelled', reason = '推送超时撤回'");
      const old = await s.run(keyOff, s.spent());
      expect(t1(old.cards)).toEqual([]);
      const r = await s.run(undefined, s.spent());
      expect(r.failed).toEqual([]);
      expect(t1(r.cards)[0]?.[0]).toMatch(/^pool_/);
      expect(s.f.intents().find((i) => i.recipient === "peer:mate")?.status).toBe("cancelled");
      expect(t1(r.cards)).toHaveLength(1); // no placement inside the group
      expect(getTask(s.f.db, "T1")?.stage).toBe("review");
      const next = await s.run(undefined); // a later pass without the starving budget places the review again (locally: no second offer)
      expect(t1(next.cards)[0]?.[0]).toBe("session");
      expect(listLendOrders(s.f.db, "T1")).toHaveLength(1);
    } finally { s.f.close(); }
  });

  test("key observe: nothing is stepped ahead of the loop, one recovery-observe sample per card and intent", async () => {
    const s = await starved();
    try {
      await s.answer();
      const observe: RecoveryPolicyPort = (project, k) => k === "autoConsumeFirst" ? { mode: "observe", manualAfterMs: null, source: "config" } : recoveryPolicy(project, k);
      for (let i = 0; i < 2; i++) expect((await s.run(observe, s.spent())).cards.map((c) => c.taskId)).toEqual(["M01"]);
      const samples = listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "autoConsumeFirst");
      expect(samples).toHaveLength(1);
      expect(s.f.task().stage).toBe("review");
    } finally { s.f.close(); }
  });

  test("[验收线 4] no pace (a bare tick): no group, the outcome list is the old one", async () => {
    const s = await starved();
    try {
      await s.answer();
      const bare = await s.run(undefined);
      expect(bare.cards.map((c) => c.taskId)).toEqual([...MERGES, "T1"]);
      expect(t1(bare.cards)).toEqual([["pool_done", expect.any(String)]]);
    } finally { s.f.close(); }
  });
});
