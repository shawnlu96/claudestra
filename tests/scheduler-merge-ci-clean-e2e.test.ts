/**
 * await_ci reads CLEAN while a shard is red before the required gate reported: the run waits in place (no unknown, no frozen queue,
 * zero merge/update/rerun), then the gate's verdict goes through bounceStep (CIF1 rerun once / ci_fail back to fix) or, all green and
 * CLEAN, through the original final source/freshness gates. Real CLI + private ledger via tests/scheduler-merge-ci-ready-kit.test.ts.
 */
import { expect, test } from "bun:test";
import { parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { readyChecks, readyLog, withReady, READY_GATE, READY_HEAD, READY_RUN, READY_SLOW } from "./scheduler-merge-ci-ready-kit.test.js";

type Fixture = Parameters<Parameters<typeof withReady>[0]>[0];
const WAIT = { phase: "await_ci", stage: "merge", frozen: false } as const;
const FROZEN = { phase: "unknown", stage: "merge", frozen: true } as const;
/** Enter await_ci the normal way (ready on a pending, CLEAN, up-to-date head), then read a CLEAN head with the given shard / gate. */
async function enterAwaitCi(f: Fixture, shard: "fail" | "cancel" = "fail", gate: "pending" | null = "pending") {
  f.hub.snapshot.mergeState = "CLEAN"; f.hub.snapshot.checks = readyChecks("pending", "pending");
  await f.tick(); expect(f.state()).toEqual(WAIT);
  f.hub.snapshot.checks = readyChecks(shard, gate);
}
function expectFix(f: Fixture) {
  expect(f.state()).toEqual({ phase: "resolved", stage: "fix", frozen: false });
  expect(parseBounceReceipt(f.row().reason!.slice("ci_fail: ".length))).toEqual({ cause: "ci_fail", prHead: READY_HEAD, mainHead: null,
    checks: [{ name: READY_GATE, link: READY_RUN }] });
  expect(f.events("merge_conflict")).toHaveLength(1);
}

for (const shard of ["fail", "cancel"] as const) for (const gate of ["pending", null] as const) {
  test(`await_ci CLEAN + shard ${shard} + gate ${gate}: waits in place every tick, zero merge/update/rerun`, async () => {
    await withReady(async (f) => {
      await enterAwaitCi(f, shard, gate); f.hub.behind = 2; // stale CLEAN: freshness is not even asked while unsettled
      const entered = f.hub.calls.length;
      for (let i = 0; i < 3; i++) { await f.tick(); expect(f.state()).toEqual(WAIT); expect(f.row().unknownSince).toBeNull(); }
      expect([f.sent(), f.events("merge_conflict"), f.events("merge_ci_rerun")]).toEqual([[], [], []]);
      expect(f.hub.calls.slice(entered).some((a) => a.includes("--log-failed") || a.some((s) => s.includes("compare/main...")))).toBe(false);
    });
  }, 180_000);
}

test("CIF5 旧红新绿：await_ci CLEAN 分片断言红、汇总 pending 原行等待；汇总随后 fail → 正式 ci_fail 退 fix，零 rerun", async () => {
  await withReady(async (f) => {
    await enterAwaitCi(f);
    await f.tick(); expect(f.state()).toEqual(WAIT);
    f.finish(); f.hub.snapshot.mergeState = "CLEAN"; await f.tick();
    expectFix(f); expect(f.sent()).toEqual([]);
  });
}, 180_000);

test("settled gate + optional red on CLEAN await_ci keeps the original unknown freeze", async () => {
  await withReady(async (f) => {
    await enterAwaitCi(f);
    f.hub.snapshot.checks = readyChecks("fail", "pass"); await f.tick();
    expect(f.state()).toEqual(FROZEN); expect(f.row().reason).toBe("CI 失败或取消");
    expect([f.sent(), f.events("merge_conflict"), f.events("merge_ci_rerun")]).toEqual([[], [], []]);
  });
}, 180_000);

test("CLEAN wait → gate timeout in an untouched test: one durable claim before the single rerun, second red bounces", async () => {
  await withReady(async (f) => {
    f.hub.log = readyLog(true);
    await enterAwaitCi(f); await f.tick(); expect(f.state()).toEqual(WAIT);
    f.hub.onRerun = () => expect(f.events("merge_ci_rerun")).toHaveLength(1);
    f.finish(); f.hub.snapshot.mergeState = "CLEAN"; await f.tick();
    expect(f.state()).toEqual(WAIT);
    expect(f.sent()).toEqual([["gh", "run", "rerun", "840", "--failed", "--repo", "example/repo"]]);
    f.finish(); f.hub.snapshot.mergeState = "CLEAN"; await f.tick();
    expectFix(f); expect(f.sent()).toHaveLength(1);
  });
}, 180_000);

for (const mode of ["unreadable", "own timeout"] as const) {
  test(`CLEAN wait → required red with ${mode} log stays fail-closed (ci_fail, no rerun)`, async () => {
    await withReady(async (f) => {
      f.hub.log = mode === "unreadable" ? null : readyLog(true);
      if (mode === "own timeout") f.hub.files.push(READY_SLOW);
      await enterAwaitCi(f); await f.tick(); expect(f.state()).toEqual(WAIT);
      f.finish(); f.hub.snapshot.mergeState = "CLEAN"; await f.tick();
      expectFix(f); expect(f.sent()).toEqual([]);
    });
  }, 180_000);
}

test("CLEAN wait → all green/CLEAN merges only through the original exact-head gates; stale main refreshes first", async () => {
  await withReady(async (f) => {
    await enterAwaitCi(f); await f.tick(); expect(f.state()).toEqual(WAIT);
    f.hub.snapshot.checks = readyChecks("pass", "pass"); f.hub.behind = 1;
    await f.tick();
    expect(f.row().phase).not.toBe("merged");
    expect(f.sent()).toEqual([["gh", "pr", "update-branch", "https://github.com/example/repo/pull/84"]]);
  });
  await withReady(async (f) => {
    await enterAwaitCi(f); await f.tick();
    f.hub.snapshot.checks = readyChecks("pass", "pass");
    f.hub.onMerge = () => expect(f.row().phase).toBe("merging");
    await f.tick();
    expect(f.state()).toEqual({ ...WAIT, phase: "merged" });
    expect(f.sent()).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/84/merge", "-f", `sha=${READY_HEAD}`, "-f", "merge_method=merge"]]);
  });
}, 180_000);

test("the CLEAN wait never hides UNKNOWN timing, DIRTY, closed/base/branch or head changes", async () => {
  const cases: [string, (f: Fixture) => void, (f: Fixture) => void][] = [
    ["UNKNOWN", (f) => { f.hub.snapshot.mergeState = "UNKNOWN"; }, (f) => {
      expect(f.state()).toEqual(WAIT); expect(f.row().unknownSince).not.toBeNull();
    }],
    ["DIRTY", (f) => { f.hub.snapshot.mergeState = "DIRTY"; }, (f) => {
      expect(f.state()).toEqual({ phase: "resolved", stage: "fix", frozen: false }); expect(f.row().reason).toStartWith("conflict");
    }],
    ["base", (f) => { f.hub.snapshot.base = "dev"; }, (f) => expect(f.state()).toEqual(FROZEN)],
    ["closed", (f) => { f.hub.snapshot.state = "CLOSED"; }, (f) => expect(f.state()).toEqual(FROZEN)],
    ["branch", (f) => { f.hub.snapshot.branch = "feat/other"; }, (f) => expect(f.state()).toEqual(FROZEN)],
    ["head", (f) => { f.hub.snapshot.head = "d".repeat(40); }, (f) => expect(f.row().phase).toBe("await_review")],
  ];
  for (const [, mutate, verify] of cases) {
    await withReady(async (f) => {
      await enterAwaitCi(f); await f.tick(); expect(f.state()).toEqual(WAIT);
      mutate(f); await f.tick(); verify(f);
      expect(f.sent()).toEqual([]);
    });
  }
}, 600_000);
