/**
 * UIR1 · pool-unsent: an auto UI card whose round PASS came from the pool (real lend claim, signed ticket, result booked; the order
 * and ticket stay bound to the reviewed head) is carried by a pure-main update; the screenshot acceptance does not follow (no render
 * proof here), so the driver's recheck finds the UI gate shut. The unsent end re-proves the source the way the send would read it
 * (sendSourceRefusal: projected onto the review's own head, the pinned seq): under on the run ends cancelled without freezing the
 * queue; a tampered order / ticket or a wrong pinned source keeps unknown + freeze. Temp ledger, real lend CLI on A and a real
 * lending side B (pool-review-proof-helpers.ts), real advanceMergeRun and driveMerge with only GitHub faked. No network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { getMeta, getTask, listEvents } from "../src/lib/ledger-store.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carrySourceTask } from "../src/lib/review-main-carry-auto-source.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeReviewProof, mergeRunDrift, type MergePhase } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-merge-refusal.js";
import { uiReviewCarryCalls } from "../src/lib/scheduler-ui-review-carry.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, DIGEST, H1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const h = (n: number) => n.toString(16).padStart(40, "0");
const MAIN1 = h(0xa1), C1 = h(0xc1), D = "e".repeat(64);
const policy = (mode: "on" | "observe" | "off") => {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiCarry: "off", uiReviewCarry: mode } } } }));
};
afterEach(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));

/** UI card, pool PASS at H1, PM's ui-approve at H1, merge run begun; then one engine carry H1 → C1 the screenshot acceptance does not follow. */
async function pooledUiCarried() {
  const f = autoFixture({ template: "ui" });
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：改 web/x.tsx\n验收：截图");
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
  expect((await b.answer(claim as never, { verdict: "pass", findings: [], report: "## 通过\n" }, (body) => peer("write", body))).r).toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "pool_done" });
  await f.cli("pm", "ui-approve", "T1", "--head", H1, "--digest", DIGEST);
  for (let i = 0; i < 4 && !f.db.query("SELECT 1 FROM scheduler_intents WHERE action = 'merge'").get(); i++) await tick();
  const intent = (f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge'").get() as { id: string }).id;
  const S = { actor: "scheduler", now: Date.now() };
  settleIntent(f.db, S, { id: intent, from: "pending", to: "submitted", receipt: "merge controller claimed" });
  beginMergeRun(f.db, S, intent, ["ci"]);
  const run = () => getMergeRun(f.db, intent)!;
  const step = (to: MergePhase, o: { receipt?: string; newHead?: string } = {}) =>
    advanceMergeRun(f.db, S, { intentId: intent, from: run().phase, to, rev: run().rev, ...o });
  step("updating");
  step("await_ci", { newHead: C1, receipt: carryReceipt({ oldHead: H1, newHead: C1, mainParent: MAIN1, mainHead: MAIN1, diffHash: D }) +
    carryChainSuffix([{ previousHead: H1, head: C1, mainParent: MAIN1 }]) });
  const sent: string[] = [];
  const ext: MergeExternal = {
    inspect: async () => ({ state: "OPEN", head: C1, branch: "task/T1", crossRepository: false, base: "main", draft: false, mergeState: "CLEAN",
      mergeSha: null, checks: [{ name: "ci", bucket: "pass" }] }),
    freshness: async () => ({ behindBy: 0, mainHead: MAIN1 }), carryReview: async () => ({ ok: false, reason: "n/a" }) as never, updateBranch: async () => {},
    merge: async (_pr, at) => { sent.push(at); return h(0xee); },
  };
  const advance = (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) =>
    Promise.resolve(advanceMergeRun(f.db, S, { intentId: intent, from, to, rev, receipt, mergeSha, newHead }));
  const drive = () => driveMerge(run(), ext, advance, () => {}, (r) => mergeRunDrift(f.db, r, Date.now()));
  return { f, order: order!, intent, run, drive, sent, frozen: () => getMeta(f.db, "p").queueFrozen.frozen };
}

describe("UIR1 pool-unsent: a pooled PASS's source is re-proved at its own head, not the carried one", () => {
  test("on: carried head, UI gate shut, pool source intact → no merge sent, resolved / cancelled, slot freed, queue not frozen", async () => {
    policy("on");
    const p = await pooledUiCarried();
    try {
      const task = getTask(p.f.db, "T1")!;
      expect(task.headSHA).toBe(C1);
      // the gate on the carried head itself finds no pooled reviewer (order / ticket bound to H1) — what froze the queue before
      expect(() => mergeReviewProof(p.f.db, task, getWorkflow(p.f.db, "T1")!)).toThrow(/跨模型审查/);
      expect(mergeReviewProof(p.f.db, carrySourceTask(p.f.db, task), getWorkflow(p.f.db, "T1")!).head).toBe(H1);
      expect(uiMergeRefusal(p.f.db, task, Date.now())).toBeTruthy();
      const before = uiReviewCarryCalls.unsent, r = await p.drive();
      expect([r.phase, p.sent, p.frozen(), getIntent(p.f.db, p.intent)!.status]).toEqual(["resolved", [], false, "cancelled"]);
      expect(p.f.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE intentId = ?").get(p.intent)).toEqual({ n: 0 });
      expect(listEvents(p.f.db, { project: "p", target: "T1" }).findLast((e) => e.data.op === "merge_phase")!.data)
        .toMatchObject({ to: "resolved", outcome: "cancelled", uiUnsent: true });
      expect(uiMergeRefusal(p.f.db, getTask(p.f.db, "T1")!, Date.now())).toBeTruthy(); // no approval invented
      expect(uiReviewCarryCalls.unsent).toBeGreaterThan(before);
    } finally { p.f.close(); }
  });

  const tamper: [string, (p: Awaited<ReturnType<typeof pooledUiCarried>>) => void][] = [
    ["the order's head was rewritten to the carried head", (p) => p.f.db.run("UPDATE lend_orders SET head = ? WHERE orderId = ?", [C1, p.order.orderId])],
    ["the order is no longer done", (p) => p.f.db.run("UPDATE lend_orders SET status = 'claimed' WHERE orderId = ?", [p.order.orderId])],
    ["the order's family no longer matches the review", (p) => p.f.db.run("UPDATE lend_orders SET family = 'claude' WHERE orderId = ?", [p.order.orderId])],
  ];
  for (const [name, twist] of tamper) {
    test(`on, ${name}: the pool source no longer re-proves → unknown + freeze, nothing sent`, async () => {
      policy("on");
      const p = await pooledUiCarried();
      try {
        twist(p);
        const r = await p.drive();
        expect([r.phase, p.sent, p.frozen()]).toEqual(["unknown", [], true]);
      } finally { p.f.close(); }
    });
  }

  for (const mode of ["observe", "off"] as const) {
    test(`${mode}: the old unknown + freeze stays`, async () => {
      policy(mode);
      const p = await pooledUiCarried();
      try {
        const r = await p.drive();
        expect([r.phase, p.sent, p.frozen()]).toEqual(["unknown", [], true]);
      } finally { p.f.close(); }
    });
  }
});
