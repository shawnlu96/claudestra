/** Regression for auto-fix-timeout-1: the real pool CLI must share queue protection with the lend sweeper. */
import { expect, test } from "bun:test";
import { getLendOrder, offerLendCore } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { answerPush, pushCandidates, recordHello } from "../src/lib/ledger-lend-peers.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { drivePool } from "../src/lib/scheduler-pool-tick.js";
import { DEFAULT_REMOTE, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

function queuedFix() {
  const f = autoFixture();
  const clock = { now: 1000000 };
  const ctx = () => ({ actor: "owner", now: clock.now });
  const borrow = { peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 3 };
  f.db.run("UPDATE tasks SET stage = 'build', round = 1 WHERE id = 'T1'");
  const input = { taskId: "T1", peer: "mate", family: "codex" as const, repo: "o/r", pr: null, spec: "修复规格", borrow,
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: "a".repeat(40), report: "P1 修复" } };
  const build = offerLendCore(f.db, ctx(), input);
  f.db.prepare("UPDATE lend_orders SET status = 'done' WHERE orderId = ?").run(build.orderId);
  f.db.prepare("UPDATE tasks SET stage = 'fix', round = 2, headSHA = ?, branch = ? WHERE id = 'T1'").run("b".repeat(40), build.branch);
  const order = offerLendCore(f.db, ctx(), input);
  f.db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev,
    head, templateVersion, status, reason, createdAt, updatedAt) VALUES ('queue-fix', 'T1', 'p', 'fix', 'dispatch', 'peer:mate',
    1, ?, 1, ?, 2, 'pending', '修复回原出借方', ?, ?)`).run(f.task().rev, f.task().headSHA, clock.now, clock.now);
  insertEvent(f.db, { ...ctx(), dedupKey: "scheduler:queue-fix:pool" }, { project: "p", target: "T1", kind: "scheduler",
    data: { op: "pool_offer", id: "queue-fix", orderId: order.orderId } }, true);
  let seq = 0;
  const hello = (busy: number) => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "queue-boot", seq: ++seq,
    grant: { until: clock.now + 86400000, roles: ["write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 10 },
    slots: { codex: { total: 1, busy }, claude: { total: 0, busy: 0 } }, paused: null }, clock.now);
  hello(1);
  expect(answerPush(f.db, ctx(), "mate", { accepted: [], refused: [{ orderId: order.orderId, code: "no_slot" }] }).notices).toHaveLength(1);
  const cli = (actor: string, ...args: string[]) => f.cliWith({ now: () => clock.now, lend: {
    borrow: async () => [borrow], notifyPm: async () => {},
    result: { reportDir: () => f.dir, writeReport: () => {}, sign: () => null },
  } }, actor, ...args);
  const sync = (remote?: RemotePolicy) => drivePool({
    manager: (...args) => cli("scheduler", ...args.slice(1)), notifyPm: async () => {},
    lost: () => (e) => { throw e; },
  }, f.task(), getIntent(f.db, "queue-fix")!, 0, remote);
  return { f, clock, hello, cli, sync, id: order.orderId };
}

for (const minutes of [undefined, 4]) {
  const policy: RemotePolicy | undefined = minutes === undefined ? undefined : { mode: "balance", roles: ["write"], poolTimeoutMin: minutes, repo: "o/r" };
  const timeout = (minutes ?? DEFAULT_REMOTE.poolTimeoutMin) * 60000;
  test(`auto fix survives pool sync while queued and can be claimed (timeout=${minutes ?? "default 15"})`, async () => {
    const p = queuedFix();
    try {
      if (minutes === undefined) expect(DEFAULT_REMOTE.poolTimeoutMin).toBe(15);
      p.clock.now += timeout + 1;
      expect(await p.sync(policy)).toMatchObject({ step: "pool_pooled" });
      expect(getLendOrder(p.f.db, p.id)?.status).toBe("pooled");
      expect(getWriteLease(p.f.db, "T1")?.state).toBe("held");
      expect(pushCandidates(p.f.db, p.clock.now)).toEqual([]);
      p.hello(0);
      const orders = pushCandidates(p.f.db, p.clock.now).map((c) => c.summary);
      expect(orders.map((o) => o.orderId)).toEqual([p.id]);
      expect(await p.cli("owner", "lend-pushing", "--", "mate", JSON.stringify({ v: 1, proto: 2, orders }))).toMatchObject({ ok: true });
      expect(await p.sync(policy)).toMatchObject({ step: "pool_pooled" });
      expect(await p.cli("owner", "lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId: p.id, worker: "w1" }))).toMatchObject({ ok: true });
      expect(await p.sync(policy)).toMatchObject({ step: "pool_claimed" });
      expect(getWriteLease(p.f.db, "T1")?.state).toBe("held");
    } finally { p.f.close(); }
  });
  test(`resumed auto fix pool timeout starts at its resumed push (timeout=${minutes ?? "default 15"})`, async () => {
    const p = queuedFix();
    try {
      p.clock.now += 2 * timeout;
      expect(await p.sync(policy)).toMatchObject({ step: "pool_pooled" });
      p.hello(0);
      const orders = pushCandidates(p.f.db, p.clock.now).map((c) => c.summary);
      expect(await p.cli("owner", "lend-pushing", "--", "mate", JSON.stringify({ v: 1, proto: 2, orders }))).toMatchObject({ ok: true });
      p.clock.now += timeout - 1;
      expect(await p.sync(policy)).toMatchObject({ step: "pool_pooled" });
      expect(getWriteLease(p.f.db, "T1")?.state).toBe("held");
      // Repeated push bookkeeping cannot move the original resumed deadline.
      expect(await p.cli("owner", "lend-pushing", "--", "mate", JSON.stringify({ v: 1, proto: 2, orders }))).toMatchObject({ ok: true });
      p.clock.now++;
      expect(await p.sync(policy)).toMatchObject({ step: "pool_timeout" });
      expect(getLendOrder(p.f.db, p.id)?.status).toBe("cancelled");
      expect(getWriteLease(p.f.db, "T1")?.state).toBe("ended");
    } finally { p.f.close(); }
  });
}

for (const command of ["lend-cancel", "lend-reclaim"]) test(`${command} still cancels a queued auto fix`, async () => {
  const p = queuedFix();
  try {
    expect(await p.cli("owner", command, "T1", "--reason", "PM 主动收回")).toMatchObject({ ok: true });
    expect(getLendOrder(p.f.db, p.id)?.status).toBe("cancelled");
    expect(await p.sync()).toMatchObject({ step: "pool_returned" });
  } finally { p.f.close(); }
});
