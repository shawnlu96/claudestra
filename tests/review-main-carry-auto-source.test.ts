/**
 * MCRY4: a pooled PASS keeps proving its source through repeated pure-main carries. Real temp ledger, the real lend CLI on A and a
 * real lending side B (pool-review-proof-helpers.ts), the production planner up to the merge intent, then the merge journal's own
 * write functions (beginMergeRun / advanceMergeRun → carryReview → autoCarryEvidence → mergeReviewProof) and the PM formal carry
 * (applyManualCarry → reviewGate). Before the fix the second carry found no pooled reviewer on the carried head and refused.
 * Refusals write nothing: a tampered order head / gen / ticket archive, an author delivery, a broken chain, a wrong round / spec.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeReviewProof, type MergePhase } from "../src/lib/scheduler-merge.js";
import { autoCarryEvidence, carryChainSuffix, type ReviewProof } from "../src/lib/review-main-carry-manual-auto.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { carrySourceTask } from "../src/lib/review-main-carry-auto-source.js";
import { applyManualCarry, reviewGate, type ManualCarryRequest } from "../src/lib/review-main-carry-manual.js";
import type { MainCarryProof } from "../src/lib/review-main-carry-proof.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const h = (n: number) => n.toString(16).padStart(40, "0");
const MAIN1 = h(0xa1), MAIN2 = h(0xa2), MAIN3 = h(0xa3), C1 = h(0xc1), C2 = h(0xc2), C3 = h(0xc3), D = "d".repeat(64);
const ON: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null, source: "config" });

/** An auto card whose round-1 PASS came from the pool (real B tools, signed ticket, archived request), now in merge with its merge intent. */
async function pooledPass() {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7', branch = 'task/T1' WHERE id = 'T1'", [spec]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const b = lendSide(f.dir), a = aResultDeps(f.dir, b.pinned);
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: a.result };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: REMOTE } }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  expect(await tick()).toMatchObject({ step: "pool_pooled" });
  const [order] = listLendOrders(f.db, "T1");
  const claim = await peer("claim", { v: 1, orderId: order!.orderId, worker: B_WORKER });
  const answer = await b.answer(claim as never, { verdict: "pass", findings: [], report: "## 通过\n" }, (body) => peer("write", body));
  expect(answer.r).toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "pool_done" });
  expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await tick()).toMatchObject({ step: "merge_queue" });
  const intent = (f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge'").get() as { id: string }).id;
  const reviewSeq = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!.seq;
  const S = { actor: "scheduler", now: Date.now() };
  settleIntent(f.db, S, { id: intent, from: "pending", to: "submitted", receipt: "merge controller claimed" });
  beginMergeRun(f.db, S, intent, ["ci"]);
  const run = () => getMergeRun(f.db, intent)!;
  const step = (to: MergePhase, o: { receipt?: string; newHead?: string; mergeSha?: string } = {}) =>
    advanceMergeRun(f.db, S, { intentId: intent, from: run().phase, to, rev: run().rev, ...o });
  /** One engine carry of one pure-main hop, as the driver's update-branch reports it (receipt + canonical chain). */
  const carry = (newHead: string, mainParent: string, chain = [[run().reviewedHead, newHead, mainParent]]) => step("await_ci", { newHead,
    receipt: carryReceipt({ oldHead: run().reviewedHead, newHead, mainParent, mainHead: mainParent, diffHash: D }) +
      carryChainSuffix(chain.map(([previousHead, head, mp]) => ({ previousHead: previousHead!, head: head!, mainParent: mp! }))) });
  const snap = () => ({ task: getTask(f.db, "T1"), run: run(), n: listEvents(f.db, { project: "p", target: "T1" }).length });
  const carries = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_carry");
  return { f, order: order!, a, answer, intent, reviewSeq, run, step, carry, snap, carries };
}

describe("MCRY4 repeated pure-main carries re-prove the pool PASS at its own head", () => {
  test("pool PASS → first carry → main moves → second carry (the MRY1 case) → third → merged; each carry names the original PASS", async () => {
    const p = await pooledPass();
    try {
      p.step("updating");
      p.carry(C1, MAIN1);
      expect(getTask(p.f.db, "T1")!.headSHA).toBe(C1);
      // the gate on the carried head itself still has no pooled reviewer (the order stays bound to H1): this is what refused before
      expect(() => mergeReviewProof(p.f.db, getTask(p.f.db, "T1")!, getWorkflow(p.f.db, "T1")!)).toThrow(/跨模型审查/);
      expect(carrySourceTask(p.f.db, getTask(p.f.db, "T1")!).headSHA).toBe(H1);
      p.step("updating");
      p.carry(C2, MAIN2);
      p.step("updating");
      p.carry(C3, MAIN3);
      expect(p.carries().map((e) => [e.data.from, e.data.to, e.data.sourceReviewSeq])).toEqual([[H1, C1, p.reviewSeq], [C1, C2, p.reviewSeq], [C2, C3, p.reviewSeq]]);
      expect(p.run()).toMatchObject({ phase: "await_ci", reviewedHead: C3 });
      p.step("merging");
      expect(p.step("merged", { receipt: "merged at pinned head", mergeSha: h(0xee) }).phase).toBe("merged");
    } finally { p.f.close(); }
  });

  test("first carry then PM pause: the formal PM carry re-proves the pool source at the PASS head, and a later formal carry chains on", async () => {
    const p = await pooledPass();
    try {
      p.step("updating");
      p.carry(C1, MAIN1);
      p.f.db.run("UPDATE task_workflows SET mode = 'manual', rev = rev + 1 WHERE taskId = 'T1'"); // PM paused the card
      p.step("resolved", { receipt: "pm switched to manual" }); // closeMergeRun: cancelled before any merge was sent
      expect(p.run().phase).toBe("resolved");
      const gate = reviewGate(p.f.db, getTask(p.f.db, "T1")!, Date.now());
      expect(gate).toMatchObject({ sourceKind: "pool", base: C1, review: { head: H1, eventSeq: p.reviewSeq } });
      const pm = (from: string, to: string, main: string): [ManualCarryRequest, MainCarryProof] => {
        const t = getTask(p.f.db, "T1")!;
        return [{ taskId: "T1", oldHead: from, newHead: to, mainHead: main, specRev: t.specRev, round: t.round, reviewSeq: p.reviewSeq, rev: t.rev },
          { ok: true, oldHead: from, newHead: to, mainHead: main, mainParent: main, diffHash: D, chain: [{ previousHead: from, head: to, mainParent: main }] } as unknown as MainCarryProof];
      };
      const one = applyManualCarry(p.f.db, { actor: "pm", now: Date.now() }, ...pm(C1, C2, MAIN2), { policy: ON });
      expect(one).toMatchObject({ status: "carried", plan: { sourceKind: "pool", sourceReviewSeq: p.reviewSeq } });
      const two = applyManualCarry(p.f.db, { actor: "pm", now: Date.now() }, ...pm(C2, C3, MAIN3), { policy: ON });
      expect(two).toMatchObject({ status: "carried", plan: { from: C2, to: C3, sourceKind: "pool" } });
      // a tampered order head after that: the same gate refuses, nothing more is written
      p.f.db.run("UPDATE lend_orders SET head = ? WHERE orderId = ?", [C3, p.order.orderId]);
      const before = listEvents(p.f.db, { project: "p", target: "T1" }).length;
      expect(() => applyManualCarry(p.f.db, { actor: "pm", now: Date.now() }, ...pm(C3, h(0xc4), h(0xa4)), { policy: ON })).toThrow(/正式沿用审查拒绝/);
      expect(listEvents(p.f.db, { project: "p", target: "T1" }).length).toBe(before);
    } finally { p.f.close(); }
  });

  test("a manual_merge run still proves the PM request's own source: the gate gets that intent, only the head is projected", async () => {
    const p = await pooledPass();
    try {
      p.step("updating");
      p.carry(C1, MAIN1);
      const seen: unknown[] = [];
      const watch: ReviewProof = (_d, t, _w, manual) => { seen.push([t.headSHA, manual?.intent.id ?? "auto"]); return { eventSeq: p.reviewSeq } as never; };
      const task = getTask(p.f.db, "T1")!, ev = { oldHead: C1, newHead: C2, mainParent: MAIN2 }, raw = JSON.stringify([[C1, C2, MAIN2]]);
      autoCarryEvidence(p.f.db, task, ev, raw, watch, () => 1, { intent: { id: "mq-1", taskId: "T1", node: "manual_merge" } as SchedulerIntent, now: 5 });
      autoCarryEvidence(p.f.db, task, ev, raw, watch, () => 1, { intent: { id: "auto-1", taskId: "T1", node: "merge_deploy" } as SchedulerIntent, now: 5 });
      expect(seen).toEqual([[H1, "mq-1"], [H1, "auto"]]);
      // and the real gate for a manual run with no live PM request refuses: a pool PASS is never turned into a manual source
      expect(() => autoCarryEvidence(p.f.db, task, ev, raw, mergeReviewProof, () => 1, { intent: { id: "mq-1", taskId: "T1", node: "manual_merge" } as SchedulerIntent, now: 5 }))
        .toThrow(/正式来源审查门不成立/);
    } finally { p.f.close(); }
  });

  const rawPath = (p: Awaited<ReturnType<typeof pooledPass>>) =>
    (listEvents(p.f.db, { project: "p", target: "T1" }).find((e) => e.kind === "review")!.data.lend as { raw: { path: string } }).raw.path;
  const refusals: [string, (p: Awaited<ReturnType<typeof pooledPass>>) => void, RegExp][] = [
    ["order head tampered to the carried head", (p) => p.f.db.run("UPDATE lend_orders SET head = ? WHERE orderId = ?", [C1, p.order.orderId]), /正式来源审查门不成立/],
    ["order lease gen drifted", (p) => p.f.db.run("UPDATE lend_orders SET leaseGen = leaseGen + 7 WHERE orderId = ?", [p.order.orderId]), /正式来源审查门不成立/],
    ["order family changed", (p) => p.f.db.run("UPDATE lend_orders SET family = 'claude' WHERE orderId = ?", [p.order.orderId]), /正式来源审查门不成立/],
    ["archived original request gone", (p) => unlinkSync(rawPath(p)), /正式来源审查门不成立/],
    ["order no longer done (withdrawn)", (p) => p.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [p.order.orderId]), /正式来源审查门不成立/],
    ["the author delivered after the review", (p) => insertEvent(p.f.db, { actor: "agent-task-one", now: Date.now() },
      { project: "p", target: "T1", kind: "deliver", text: "", data: { headSHA: C1 } }, false), /审查结论已不合格/],
    ["round moved", (p) => p.f.db.run("UPDATE tasks SET round = round + 1 WHERE id = 'T1'"), /审查结论已不合格/],
  ];
  for (const [name, spoil, why] of refusals) {
    test(`second carry refused, zero writes: ${name}`, async () => {
      const p = await pooledPass();
      try {
        p.step("updating");
        p.carry(C1, MAIN1);
        p.step("updating");
        spoil(p);
        const before = p.snap();
        expect(() => p.carry(C2, MAIN2)).toThrow(why);
        expect(p.snap()).toEqual(before);
        expect(p.carries()).toHaveLength(1);
        // whatever stage refuses first (run drift or the in-transaction gate), the source projection itself never finds an older PASS
        if (/审查结论已不合格/.test(String(why))) expect(carrySourceTask(p.f.db, getTask(p.f.db, "T1")!).headSHA).toBe(C1);
      } finally { p.f.close(); }
    });
  }

  test("a broken or foreign chain on the second carry refuses with zero writes; the first carry's evidence is untouched", async () => {
    const p = await pooledPass();
    try {
      p.step("updating");
      p.carry(C1, MAIN1);
      p.step("updating");
      const before = p.snap();
      expect(() => p.carry(C2, MAIN2, [[H1, C2, MAIN2]])).toThrow(/不连续/); // chain starting at the old PASS head, skipping the carried one
      expect(() => p.carry(C2, MAIN2, [[C1, C2, MAIN1]])).toThrow(/main 父提交/);
      expect(p.snap()).toEqual(before);
      expect(p.carries()[0]!.data).toMatchObject({ from: H1, to: C1, sourceReviewSeq: p.reviewSeq });
    } finally { p.f.close(); }
  });
});
