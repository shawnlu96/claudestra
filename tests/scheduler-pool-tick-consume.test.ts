/**
 * AUTOSTARVE1 · a done / cancelled / released lend order is synced onto its intent without PRIO2's slot re-read (claimSlot):
 * consuming a result takes no slot, so a slot a higher band now owns never holds it. Live orders and the key off / observe keep
 * the re-read. The slot is really full: the owner swaps the bands after the pass's sort, as in scheduler-priority-order-wiring.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readPriority, readPriorityModes } from "../src/lib/ledger-priority-read.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import type { PriorityBand } from "../src/lib/ledger-priority-types.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { resetSlotQueues } from "../src/lib/scheduler-priority-order.js";
import { drivePool } from "../src/lib/scheduler-pool-tick.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const evidence = { ownerWords: "owner 原话", ownerAt: 1000, sourceRef: "discord:owner/1" };
let seq = 0;
const owner = () => ({ actor: "owner", project: "p", now: 2000, dedupKey: `consume-slot-${++seq}` });
const band = (db: Database, id: string, b: PriorityBand) =>
  setPriority(db, owner(), { target: { kind: "task", id }, rev: readPriority(db, "p", { kind: "task", id }).rev, band: b, evidence });

let f: ReturnType<typeof autoFixture>;
beforeEach(() => {
  resetSlotQueues();
  f = autoFixture();
  createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "T2", kind: "code", agent: "agent-task-one" });
  setWorkflow(f.db, f.at("owner"), { taskId: "T2", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
});
afterEach(() => f.close());

/** T1's pool intent i-1 is linked to order o1 in `order`; the slot queue then puts T2 (now) ahead of T1 (later). */
async function syncWithSlotTaken(order: string, consume: RecoveryMode) {
  setPriorityMode(f.db, owner(), { mechanism: "prioritySort", mode: "on", rev: readPriorityModes(f.db, "p").prioritySort.rev, evidence });
  band(f.db, "T1", "now"); band(f.db, "T2", "later");
  await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, prepareAuthor: async () => ({ deferred: true, reason: "只排序" }) as never });
  band(f.db, "T1", "later"); band(f.db, "T2", "now");
  insertEvent(f.db, { actor: "scheduler", now: 3000, dedupKey: "scheduler:i-1:pool" }, { project: "p", target: "T1", kind: "scheduler", text: "挂池", data: { orderId: "o1" } }, true);
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, createdBy,
    createdAt, updatedAt) VALUES ('o1', 'T1', 'p', 'mate', 'codex', 'review', 1, 1, ?, 'o/r', '{}', 't', 's', ?, 600000, 'scheduler', 3000, 3000)`).run("a".repeat(40), order);
  const calls: string[][] = [];
  const r = await drivePool({ db: f.db, manager: async (...a) => { calls.push(a); return { ok: true, outcome: order, text: `结论已入账（${order}）` }; },
    notifyPm: async () => {}, lost: () => () => {},
    recoveryPolicy: (_p, k) => ({ mode: k === "autoConsumeFirst" ? consume : "off", manualAfterMs: null, source: "config" }) },
  f.task(), { id: "i-1", taskId: "T1", project: "p", status: "submitted" } as SchedulerIntent, 2, undefined);
  return { r, synced: calls.some((a) => a[1] === "scheduler-pool") };
}

test("[验收线 3] slot taken by a higher band: a done order is still synced to its intent (old red: held, never synced)", async () => {
  const { r, synced } = await syncWithSlotTaken("done", "on");
  expect(r).toEqual({ step: "pool_done", detail: "结论已入账（done）" });
  expect(synced).toBe(true);
});

for (const order of ["cancelled", "released"]) {
  test(`slot taken: a ${order} order is synced too`, async () => {
    const { r, synced } = await syncWithSlotTaken(order, "on");
    expect([r.step, synced]).toEqual([`pool_${order}`, true]);
  });
}

for (const [order, mode] of [["claimed", "on"], ["unknown", "on"], ["done", "off"], ["done", "observe"]] as const) {
  test(`${order} order, key ${mode}: the slot re-read still holds it (current rules)`, async () => {
    const { r, synced } = await syncWithSlotTaken(order, mode);
    expect(r).toMatchObject({ step: "held", detail: expect.stringContaining("T2（now）") });
    expect(synced).toBe(false);
  });
}
