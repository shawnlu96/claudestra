import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerPush, recordHello } from "../src/lib/ledger-lend-peers.js";
import { claimLend, leaseLend, listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

async function ready(stage: "build" | "review", pinned = false) {
  const f = autoFixture();
  const spec = join(f.dir, "spec.md");
  writeFileSync(spec, "实现 src/lib/x.ts；验收：相关单测通过");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  await toBuild(f);
  if (pinned) f.db.run("UPDATE tasks SET extra = json_set(extra, '$.placement', 'peer:mate') WHERE id = 'T1'");
  if (stage === "review") {
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    f.db.run("UPDATE tasks SET pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'");
    f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
  }
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 2 }];
  const remote: RemotePolicy = { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15, writeFamilies: ["claude"] };
  const policy = { maxActiveWorkers: 2, remote };
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => f.dir, writeReport: writeFileSync, sign: () => null,
      peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async () => ({ ok: true as const, head: H1 }) } };
  const cli = (...args: string[]) => f.cliWith({ lend }, "scheduler", ...args);
  const tick = () => schedulerAutoTick(f.db, { p: policy }, { ...f.tickDeps, borrow: async () => borrow, manager: (...args) => cli(...args.slice(1)) });
  let seq = 0;
  const hello = (busy = 0, left = 50, paused = false, replay = false, claudeTotal = 2) => recordHello(f.db, "mate", null, {
    v: 1, proto: 2, boot: "boot-mate", seq: replay ? seq : ++seq,
    grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: left },
    slots: { claude: { total: claudeTotal, busy }, codex: { total: 0, busy: 0 } },
    paused: paused ? { reason: "manual", until: f.tickDeps.now() + 60_000 } : null,
  }, f.tickDeps.now());
  const orders = () => listLendOrders(f.db, "T1");
  const plan = () => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: { remote, borrow } }));
  const refuse = (code = "no_slot") => answerPush(f.db, { actor: "owner", now: f.tickDeps.now() }, "mate",
    { accepted: [], refused: [{ orderId: orders().at(-1)!.orderId, code }] });
  hello();
  return { f, tick, hello, orders, plan, refuse };
}

for (const [stage, pinned] of [["review", false], ["build", false], ["build", true]] as const) {
test(`${stage} pinned=${pinned}: real tick reoffers a refused Claude order without PM or local dispatch`, async () => {
  const p = await ready(stage, pinned);
  try {
    const sent = p.f.sent.length, notices = p.f.notices.length;
    expect((await p.tick()).cards[0]).toMatchObject({ step: "pool_pooled" });
    expect(p.orders()[0]).toMatchObject({ status: "pooled", family: "claude" });
    expect(p.refuse().withdrawn).toHaveLength(1);
    if (stage === "build") expect(getWriteLease(p.f.db, "T1")?.state).toBe("ended");
    expect((await p.tick()).cards[0]).toMatchObject({ step: "pool_returned" });
    p.f.advance(119_000);
    p.hello();
    expect(p.plan()).toMatchObject({ kind: "wait", code: pinned ? "placement_pinned" : "placement", reason: expect.stringContaining("等 mate 空位") });
    await p.tick();
    expect(p.orders()).toHaveLength(1);
    p.f.advance(1000);
    p.hello();
    expect(p.plan()).toMatchObject({ kind: "intent", recipient: "peer:mate" });
    expect((await p.tick()).cards[0]).toMatchObject({ step: "pool_pooled" });
    expect(p.orders()).toHaveLength(2);
    expect(p.orders()[1]).toMatchObject({ status: "pooled", family: "claude" });
    expect(p.orders()[1].orderId).not.toBe(p.orders()[0].orderId);
    if (stage === "build") expect(getWriteLease(p.f.db, "T1")?.state).toBe("held");
    expect(p.f.sent).toHaveLength(sent);
    expect(p.f.notices).toHaveLength(notices);
    expect(p.f.ensured.filter((r) => r.role === "reviewer")).toEqual([]);
  } finally { p.f.close(); }
});
}

test("ledger hello must actually advance; full, paused or daily-exhausted peers keep placement waiting", async () => {
  const p = await ready("review");
  try {
    await p.tick();
    p.refuse();
    await p.tick();
    p.f.advance(120_000);
    expect(p.hello(0, 50, false, true)).toEqual({ applied: false });
    expect(p.plan()).toMatchObject({ kind: "wait", reason: expect.stringContaining("新 hello") });
    for (const [busy, left, pause] of [[2, 50, false], [0, 0, false], [0, 50, true]] as const) {
      p.hello(busy, left, pause);
      expect(p.plan()).toMatchObject({ kind: "wait", code: "placement", reason: expect.stringContaining("等 mate 空位") });
    }
    p.hello();
    expect((await p.tick()).cards[0]).toMatchObject({ step: "pool_pooled" });
  } finally { p.f.close(); }
});

for (const code of ["no_grant", "role", "repo"]) test(`ledger ${code} never reoffers to this peer`, async () => {
  const p = await ready("review");
  try {
    await p.tick();
    p.refuse(code);
    await p.tick();
    p.f.advance(120_000);
    p.hello();
    expect(p.plan()).toMatchObject({ kind: "intent", action: "ensure_session" });
    expect(p.orders()).toHaveLength(1);
  } finally { p.f.close(); }
});

for (const stage of ["review", "build"] as const) test(`${stage}: real hello distinguishes exhausted slots from revoked family`, async () => {
  const p = await ready(stage);
  try {
    await p.tick();
    p.refuse();
    await p.tick();
    p.f.advance(120_000);
    p.hello(2);
    expect(p.plan()).toMatchObject({ kind: "wait", reason: expect.stringContaining("等 mate 空位") });
    p.hello(0, 50, false, false, 0);
    expect(p.plan()).toMatchObject(stage === "review" ? { action: "ensure_session" } : { action: "dispatch", recipient: "agent-task-one" });
    expect(p.orders()).toHaveLength(1);
  } finally { p.f.close(); }
});

for (const prior of ["timeout", "claimed_return"] as const) {
  for (const newHello of [true, false]) test(`ADV-1/1c: pinned ${prior} then no_slot, new hello=${newHello}`, async () => {
    const p = await ready("build", true);
    try {
      expect((await p.tick()).cards[0].step).toBe("pool_pooled");
      if (prior === "timeout") {
        p.f.advance(15 * 60_000 + 1000);
        p.hello();
        expect((await p.tick()).cards[0].step).toBe("pool_timeout");
      } else {
        const orderId = p.orders()[0].orderId;
        const ctx = { actor: "owner", now: p.f.tickDeps.now() };
        claimLend(p.f.db, ctx, "mate", { v: 1, orderId, worker: "w1" },
          () => ({ peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 2 }));
        expect(p.orders()[0].status).toBe("claimed");
        leaseLend(p.f.db, ctx, "mate", { v: 1, orderId, gen: 1, action: "release", reason: "not_started", detail: "clone failed" });
        expect((await p.tick()).cards[0].step).toBe("pool_returned");
      }
      expect((await p.tick()).cards[0].step).toBe("pool_pooled");
      expect(p.orders()).toHaveLength(2);
      expect(p.refuse().withdrawn).toHaveLength(1);
      expect((await p.tick()).cards[0].step).toBe("pool_returned");
      p.f.advance(10_000);
      if (newHello) p.hello();
      for (let n = 0; n < 4; n++) {
        expect(p.plan()).toMatchObject({ kind: "wait", code: "placement_pinned", reason: expect.stringContaining("2 分钟") });
        await p.tick();
        expect(p.orders()).toHaveLength(2);
        p.f.advance(15_000);
      }
      p.f.advance(50_000);
      if (!newHello) {
        expect(p.plan()).toMatchObject({ kind: "wait", reason: expect.stringContaining("新 hello") });
        await p.tick();
        expect(p.orders()).toHaveLength(2);
        p.hello();
      }
      expect(p.plan()).toMatchObject({ kind: "intent", recipient: "peer:mate" });
      expect((await p.tick()).cards[0].step).toBe("pool_pooled");
      expect(p.orders()).toHaveLength(3);
      expect(getWriteLease(p.f.db, "T1")?.state).toBe("held");
    } finally { p.f.close(); }
  });
}
