import { expect, test } from "bun:test";
import { parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { MERGE_NOT_SENT } from "../src/lib/manual-merge-queue-facts.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { getTask } from "../src/lib/ledger-store.js";
import { readyChecks, readyLog, withReady, READY_GATE, READY_HEAD, READY_PR, READY_RUN, READY_SLOW } from "./scheduler-merge-ci-ready-kit.test.js";

const WAIT = { phase: "ready", stage: "merge", frozen: false } as const, FIX = { phase: "resolved", stage: "fix", frozen: false } as const;
function expectFix(f: Parameters<Parameters<typeof withReady>[0]>[0]) {
  expect(f.state()).toEqual(FIX);
  expect(f.row().reason).toStartWith("ci_fail: ");
  expect(parseBounceReceipt(f.row().reason!.slice("ci_fail: ".length))).toEqual({ cause: "ci_fail", prHead: READY_HEAD, mainHead: null,
    checks: [{ name: READY_GATE, link: READY_RUN }] });
  expect(f.events("merge_conflict")).toHaveLength(1);
  expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge84'").get()).toEqual({ status: "cancelled" });
  expect(f.db.query("SELECT * FROM scheduler_resources WHERE intentId='merge84'").all()).toEqual([]);
  expect(getTask(f.db, "R84")!.headSHA).toBe(READY_HEAD);
}

test("CIF4 旧红新绿：ready 分片断言红、汇总 pending → 不冻不合，汇总 fail → 正式 ci_fail 退 fix，零 rerun", async () => {
  await withReady(async (f) => {
    await f.tick();
    expect(f.state()).toEqual(WAIT);
    expect([f.sent(), f.events("merge_conflict"), f.events("merge_ci_rerun")]).toEqual([[], [], []]);
    expect(f.row().unknownSince).toBeNull();
    f.finish();
    await f.tick();
    expectFix(f);
    expect(f.sent()).toEqual([]);
    expect(f.childCalls.map((a) => a[1])).toContain("scheduler-merge-step");
  });
}, 180_000);

for (const mergeState of ["CLEAN", "UNSTABLE", "BEHIND"]) for (const shard of ["fail", "cancel"] as const) for (const gate of [null, "pending"] as const) {
  test(`ready ${mergeState} ${shard} + gate ${gate}: repeated real CLI ticks never treat pending/absent as green`, async () => {
    await withReady(async (f) => {
      f.hub.snapshot.mergeState = mergeState; f.hub.behind = 2;
      f.hub.snapshot.checks = readyChecks(shard, gate);
      for (let i = 0; i < 3; i++) { await f.tick(); expect(f.state()).toEqual(WAIT); }
      expect(f.sent()).toEqual([]);
      expect(f.hub.calls.some((a) => a.includes("--log-failed"))).toBe(false);
    });
  }, 180_000);
}
for (const mode of ["unreadable", "unparsed", "own timeout"] as const) {
  test(`ready → required red: ${mode} remains fail-closed without rerun`, async () => {
    await withReady(async (f) => {
      f.hub.log = mode === "unreadable" ? null : mode === "unparsed" ? "not a test log" : readyLog(true);
      if (mode === "own timeout") f.hub.files.push(READY_SLOW);
      await f.tick(); expect(f.state()).toEqual(WAIT);
      f.finish(); await f.tick(); expectFix(f); expect(f.sent()).toEqual([]);
    });
  }, 180_000);
}
for (const gate of ["fail", "cancel"] as const) {
  test(`ready → required ${gate}: untouched timeout has one durable claim before rerun, second red bounces`, async () => {
    await withReady(async (f) => {
      f.hub.log = readyLog(true);
      await f.tick(); expect(f.state()).toEqual(WAIT);
      f.hub.onRerun = () => {
        expect(f.events("merge_ci_rerun")).toHaveLength(1); // durable claim is already visible before external send
        expect(f.row().phase).toBe("ready");
      };
      f.finish(gate); await f.tick();
      expect(f.state()).toEqual(WAIT);
      expect(f.events("merge_ci_rerun")).toEqual([expect.objectContaining({ data: expect.objectContaining({
        prHead: READY_HEAD, checks: [READY_GATE], run: READY_RUN, cases: [`${READY_SLOW} > outside > ready fixture`] }) })]);
      expect(f.sent()).toEqual([["gh", "run", "rerun", "840", "--failed", "--repo", "example/repo"]]);
      await f.tick(); expect(f.state()).toEqual(WAIT); // newer attempt still queued
      f.finish(gate); await f.tick(); expectFix(f);
      expect(f.sent()).toHaveLength(1);
    });
  }, 180_000);
}

test("waiting ready → all green/CLEAN: original final source/lease/freshness gates and exact reviewed head merge", async () => {
  await withReady(async (f) => {
    await f.tick(); expect(f.state()).toEqual(WAIT);
    f.hub.snapshot.checks = readyChecks("pass", "pass"); f.hub.snapshot.mergeState = "CLEAN";
    await f.tick(); expect(f.state()).toEqual({ ...WAIT, phase: "await_ci" });
    f.hub.onMerge = () => {
      expect(f.row().phase).toBe("merging");
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge84'").get()).toEqual({ status: "submitted" });
    };
    await f.tick();
    expect(f.state()).toEqual({ ...WAIT, phase: "merged" });
    expect(f.sent()).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/84/merge", "-f", `sha=${READY_HEAD}`, "-f", "merge_method=merge"]]);
    expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='merge84'").get()).toEqual({ status: "done" });
    expect(f.hub.calls.filter((a) => a[1] === "pr" && a[2] === "view" && a[3] === READY_PR)).toHaveLength(5);
  });
}, 180_000);

for (const mergeState of ["CLEAN", "UNSTABLE", "BEHIND"]) {
  test(`${mergeState} waiting ends with required assertion red through CIF1/CIF2`, async () => {
    await withReady(async (f) => {
      f.hub.snapshot.mergeState = mergeState;
      await f.tick(); expect(f.state()).toEqual(WAIT);
      f.finish(); await f.tick(); expectFix(f); expect(f.sent()).toEqual([]);
    });
  }, 180_000);
}
for (const gate of ["pass", "skipping"] as const) for (const shard of ["fail", "cancel"] as const) {
  test(`settled ${gate} + optional ${shard}: queue frozen only by original unknown, no formal ci_fail/rerun`, async () => {
    await withReady(async (f) => {
      f.hub.snapshot.checks = readyChecks(shard, gate);
      await f.tick();
      expect(f.state()).toEqual({ phase: "unknown", stage: "merge", frozen: true });
      expect(f.row().reason).toBe("CI 失败或取消");
      expect([f.sent(), f.events("merge_conflict"), f.events("merge_ci_rerun")]).toEqual([[], [], []]);
    });
  }, 180_000);
}
test("all green after ready wait still obeys source revocation after merging claim", async () => {
  await withReady(async (f) => {
    await f.tick();
    f.hub.snapshot.checks = readyChecks("pass", "pass"); f.hub.snapshot.mergeState = "CLEAN";
    await f.tick(); expect(f.row().phase).toBe("await_ci");
    f.hooks.afterWrite = (args) => {
      if (args.includes("merging")) f.db.query("UPDATE scheduler_sessions SET sessionId='revoked' WHERE role='reviewer'").run();
    };
    await f.tick();
    expect(f.state()).toEqual({ phase: "unknown", stage: "merge", frozen: true });
    expect(f.row().reason).toStartWith(MERGE_NOT_SENT);
    expect(f.sent()).toEqual([]);
  });
}, 180_000);
for (const mode of ["manual", "observe"] as const) {
  test(`workflow becomes ${mode} during ready wait: original policy gate wins before network`, async () => {
    await withReady(async (f) => {
      await f.tick(); const before = f.hub.calls.length;
      f.db.query("UPDATE task_workflows SET mode=? WHERE taskId='R84'").run(mode);
      await f.tick();
      expect(f.state()).toEqual(mode === "manual" ? { phase: "resolved", stage: "merge", frozen: false }
        : { phase: "unknown", stage: "merge", frozen: true });
      expect([f.hub.calls.length, f.sent()]).toEqual([before, []]);
    });
  }, 180_000);
}
test("lost service ownership while waiting propagates SchedulerStopped, keeps journal, sends nothing", async () => {
  await withReady(async (f) => {
    await f.tick(); const before = f.row(), stop = new SchedulerStopped("fixture lost lease");
    f.guard.check = () => { throw stop; };
    await expect(f.tick()).rejects.toBe(stop);
    expect(f.row()).toEqual(before); expect(f.state()).toEqual(WAIT); expect(f.sent()).toEqual([]);
  });
}, 180_000);
