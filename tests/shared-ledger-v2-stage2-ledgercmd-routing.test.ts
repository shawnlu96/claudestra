import { describe, expect, test } from "bun:test";
import { createTask } from "../src/lib/ledger-write.js";
import { writeSlotFacts } from "../src/lib/scheduler-slot-hold-facts.js";
import { withSchedulerV2LedgerCmds } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { ledgercmdFixture, seq } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";

function lendOrder(s: ReturnType<typeof ledgercmdFixture>, id = "lend:T1:s1:r1:a0") {
  s.f.db.query(`INSERT INTO lend_orders
    (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,leaseMs,createdBy,createdAt,updatedAt)
    VALUES (?,'T1','p','peer','codex','write',1,1,?,'owner/repo','{}','synthetic',?,'claimed',1000,'owner',1000,1000)`)
    .run(id, "a".repeat(40), "b".repeat(64));
  return ["ledger", "lend-takeover", id, "--head", "c".repeat(40), "--pr", "1"];
}

describe("stage2 ledger order routing and stale slot regressions", () => {
  test("lend-takeover-1 resolves a lend order to its central card without calling manager", async () => {
    const s = ledgercmdFixture(), args = lendOrder(s);
    s.port.route = id => id === "T1" ? "central" : "local";
    const before = seq(s.f.db), order = s.f.db.query("SELECT * FROM lend_orders").all();
    expect(await s.manager(...args)).toEqual({ ok: false, code: "v2_unmapped" });
    expect(s.counters()).toEqual({ syncs: 0, managerCalls: 0 });
    expect(s.requests).toHaveLength(0);
    expect(seq(s.f.db)).toBe(before);
    expect(s.f.db.query("SELECT * FROM lend_orders").all()).toEqual(order);
  });

  test("lend order lookup is authoritative over the task name in its id", async () => {
    const s = ledgercmdFixture(), args = lendOrder(s, "lend:other:s1:r1:a0");
    s.port.route = id => id === "T1" ? "central" : "local";
    expect(await s.manager(...args)).toEqual({ ok: false, code: "v2_unmapped" });
    expect(s.counters().managerCalls).toBe(0);
  });

  test("a missing canonical lend order on a central card is held", async () => {
    const s = ledgercmdFixture();
    s.port.route = id => id === "T1" ? "central" : "local";
    expect(await s.manager("ledger", "lend-takeover", "lend:T1:s1:r1:a0", "--head", "c".repeat(40), "--pr", "1"))
      .toEqual({ ok: false, code: "v2_unmapped" });
    expect(s.counters().managerCalls).toBe(0);
    expect(s.requests).toHaveLength(0);
  });

  test.each(["scheduler-review-hold", "scheduler-review-downgrade", "scheduler-manual-resume"])(
    "%s recovery writes on a central card are held", async command => {
      const s = ledgercmdFixture();
      s.port.route = id => id === "T1" ? "central" : "local";
      expect(await s.manager("ledger", command, "T1")).toEqual({ ok: false, code: "v2_unmapped" });
      expect(s.counters().managerCalls).toBe(0);
      expect(s.requests).toHaveLength(0);
    },
  );

  test("project-wide calls require S2F policy and preserve their original responses here", async () => {
    const s = ledgercmdFixture(), sentinel = { ok: true, opaque: {} }, calls: string[][] = [];
    s.port.route = id => id === "T1" ? "central" : "local";
    const manager = withSchedulerV2LedgerCmds(async (...args) => { calls.push(args); return sentinel; }, s.port);
    const commands = [["ledger", "manual-merge-claim", "p"], ["ledger", "peer-pr-intake", "--project", "p"],
      ["ledger", "memory-auto", "--project", "p"]];
    for (const args of commands) expect(await manager(...args)).toBe(sentinel);
    expect(calls).toEqual(commands);
    expect(s.requests).toHaveLength(0);
  });

  test.each(["local", "skip"] as const)("lend-takeover preserves the exact %s response and arguments", async route => {
    const s = ledgercmdFixture(), args = lendOrder(s), sentinel = { ok: true, opaque: {} }, calls: string[][] = [];
    s.port.route = id => id === "T1" ? route : "central";
    const manager = withSchedulerV2LedgerCmds(async (...input) => { calls.push(input); return sentinel; }, s.port);
    expect(await manager(...args)).toBe(sentinel);
    expect(calls).toEqual([args]);
    expect(s.requests).toHaveLength(0);
  });

  test.each(["other-card", "own-card"])("slot-stale-1 ignores a stale %s slot without cleaning the ledger", async owner => {
    const s = ledgercmdFixture();
    const taskId = owner === "own-card" ? "T1" : "T2";
    if (taskId === "T2") {
      createTask(s.f.db, { actor: "owner", now: 2000 }, { project: "p", id: taskId, title: "finished", kind: "code" });
    }
    s.f.db.query("UPDATE tasks SET stage=? WHERE id=?").run(taskId === "T1" ? "review" : "done", taskId);
    const row = s.seed("prior", "dispatch", "done");
    row.taskId = taskId;
    await s.port.sync("p", "feature-one");
    s.f.db.query("INSERT INTO scheduler_resources VALUES ('p','slot:p:0',?,'prior',1000,'card')").run(taskId);
    expect(writeSlotFacts(s.f.db, "p").stale).toContainEqual({ resource: "slot:p:0", taskId });
    const before = seq(s.f.db), resources = s.f.db.query("SELECT * FROM scheduler_resources").all();
    const client = s.port.clientFor("p")!;
    s.port.clientFor = () => ({ command: async command => {
      expect(seq(s.f.db)).toBe(before);
      expect(s.f.db.query("SELECT * FROM scheduler_resources").all()).toEqual(resources);
      return client.command(command);
    } });
    const key = taskId === "T1" ? "slot:p:1" : "slot:p:0";
    expect(await s.manager(...s.plan("after-stale", taskId === "T1" ? "review" : "dispatch", "restate", key)))
      .toMatchObject({ ok: true });
    expect(s.requests).toHaveLength(1);
    expect(s.counters().managerCalls).toBe(0);
  });
});
