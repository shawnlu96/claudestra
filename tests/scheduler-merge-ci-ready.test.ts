import { expect, test } from "bun:test";
import { driveMerge, MERGE_STATE_UNKNOWN_LIMIT_MS, UNKNOWN_LIMIT_REASON, type MergeAdvance, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { bounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { readyChecks, READY_GATE, READY_HEAD, READY_MAIN, READY_PR } from "./scheduler-merge-ci-ready-kit.test.js";

function driverReady(change: Partial<PrSnapshot> = {}, phase: MergeRun["phase"] = "ready") {
  let row: MergeRun = { intentId: "test-ready", taskId: "R84", project: "p", prRef: READY_PR, expectedBranch: "feat/r84",
    reviewedHead: READY_HEAD, requiredChecks: READY_GATE, phase, rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1, unknownSince: null };
  const snapshot: PrSnapshot = { state: "OPEN", head: READY_HEAD, branch: "feat/r84", base: "main", draft: false,
    crossRepository: false, mergeState: "UNSTABLE", mergeSha: null, checks: readyChecks("fail", "pending"), ...change };
  const actions: string[] = [], receipts: (string | undefined)[] = [];
  const external: MergeExternal = {
    inspect: async () => { actions.push("inspect"); return snapshot; },
    freshness: async () => { actions.push("freshness"); return { behindBy: 0, mainHead: READY_MAIN }; },
    updateBranch: async () => { actions.push("update"); },
    carryReview: async () => { actions.push("carry"); return { ok: false, reason: "author pushed" }; },
    merge: async () => { throw new Error("unit fixture must never merge"); },
  };
  const advance: MergeAdvance = async (from, to, rev, receipt, sha, head) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    actions.push(`step:${to}`); receipts.push(receipt);
    row = { ...row, phase: to, reason: receipt ?? null, rev: row.rev + 1, mergeSha: sha ?? row.mergeSha, reviewedHead: head ?? row.reviewedHead };
    return row;
  };
  return { snapshot, external, advance, actions, receipts, row: () => row, setRow: (delta: Partial<MergeRun>) => { row = { ...row, ...delta }; },
    tick: () => driveMerge(row, external, advance) };
}

for (const mergeState of ["CLEAN", "UNSTABLE", "BEHIND"]) for (const shard of ["fail", "cancel"] as const) {
  for (const gate of [null, "pending"] as const) {
    test(`ready ${mergeState}, shard ${shard}, required ${gate}: wait before freshness, no journal or send`, async () => {
      const f = driverReady({ mergeState, checks: readyChecks(shard, gate) });
      const before = f.row();
      for (let i = 0; i < 2; i++) expect(await f.tick()).toBe(before);
      expect(f.actions).toEqual(["inspect", "inspect"]);
      expect(f.receipts).toEqual([]);
    });
  }
}
for (const gate of ["pass", "skipping"] as const) for (const shard of ["fail", "cancel"] as const) {
  test(`ready settled required ${gate} with optional ${shard}: exact original unknown`, async () => {
    const f = driverReady({ checks: readyChecks(shard, gate) });
    await f.tick();
    expect([f.row().phase, f.row().reason, f.actions]).toEqual(["unknown", "CI 失败或取消", ["inspect", "freshness", "step:unknown"]]);
    expect(f.receipts).toEqual(["CI 失败或取消"]);
  });
}
for (const gate of [null, "pending"] as const) {
  test(`BLOCKED + gate ${gate} + nonrequired red: freshness not behind still original unknown`, async () => {
    const f = driverReady({ mergeState: "BLOCKED", checks: readyChecks("fail", gate) });
    await f.tick();
    expect([f.row().phase, f.row().reason]).toEqual(["unknown", "PR mergeState=BLOCKED"]);
    expect(f.actions).toEqual(["inspect", "freshness", "step:unknown"]);
  });
}

test("BLOCKED already behind remains the original freshness update path", async () => {
  const f = driverReady({ mergeState: "BLOCKED" });
  f.external.freshness = async () => ({ behindBy: 1, mainHead: READY_MAIN });
  await f.tick();
  expect([f.row().phase, f.actions]).toEqual(["updating", ["inspect", "step:updating", "update"]]);
});
test("BEHIND only delays update in the unsettled window; all green still rechecks and updates before merging", async () => {
  const f = driverReady({ mergeState: "BEHIND" });
  await f.tick(); expect(f.row().phase).toBe("ready");
  f.snapshot.checks = readyChecks("pass", "pass");
  f.external.freshness = async () => { f.actions.push("freshness"); return { behindBy: 2, mainHead: READY_MAIN }; };
  await f.tick();
  expect([f.row().phase, f.actions]).toEqual(["updating", ["inspect", "inspect", "freshness", "step:updating", "update"]]);
});

test("true mergeability UNKNOWN preserves its original bounded timer despite unsettled CI", async () => {
  const f = driverReady({ mergeState: "UNKNOWN" });
  f.setRow({ unknownSince: Date.now() - MERGE_STATE_UNKNOWN_LIMIT_MS + 60_000 });
  const before = f.row();
  expect(await f.tick()).toBe(before);
  f.setRow({ unknownSince: Date.now() - MERGE_STATE_UNKNOWN_LIMIT_MS });
  await f.tick();
  expect([f.row().phase, f.row().reason]).toEqual(["unknown", UNKNOWN_LIMIT_REASON]);
  expect(f.actions).toEqual(["inspect", "inspect", "step:unknown"]);
});
test("UNKNOWN observations begin through the original receipt; leaving UNKNOWN clears its timer before ready CI wait", async () => {
  const f = driverReady({ mergeState: "UNKNOWN" });
  await f.tick();
  expect(f.receipts).toEqual(["GitHub 合并状态：UNKNOWN，等待计算"]);
  f.setRow({ unknownSince: Date.now() }); f.snapshot.mergeState = "UNSTABLE";
  await f.tick();
  expect(f.receipts).toEqual(["GitHub 合并状态：UNKNOWN，等待计算", "GitHub 合并状态：结束 UNKNOWN 等待"]);
  expect(f.row().phase).toBe("ready");
});

test("DIRTY beats unsettled CI and takes the original conflict receipt", async () => {
  const f = driverReady({ mergeState: "DIRTY" });
  await f.tick();
  expect([f.row().phase, f.row().reason]).toEqual(["resolved", bounceReceipt({ cause: "conflict", prHead: READY_HEAD, mainHead: READY_MAIN, checks: [] })]);
  expect(f.actions).toEqual(["inspect", "freshness", "step:resolved"]);
});
const invalid: Partial<PrSnapshot>[] = [{ base: "dev" }, { branch: "feat/other" }, { crossRepository: true }, { state: "CLOSED" }, { state: "MERGED" }];
for (const change of invalid) {
  test(`identity ${JSON.stringify(change)} still refuses before CI wait`, async () => {
    const f = driverReady(change);
    await f.tick();
    expect(f.row().phase).toBe("unknown"); expect(f.row().reason).toStartWith("PR 状态、base 或审查 head 已变：");
    expect(f.actions).toEqual(["inspect", "step:unknown"]);
  });
}
test("ready draft keeps its original wait; author head change returns to review before any CI gate", async () => {
  const draft = driverReady({ draft: true });
  expect(await draft.tick()).toBe(draft.row()); expect(draft.actions).toEqual(["inspect"]);
  const moved = driverReady({ head: "d".repeat(40) });
  await moved.tick(); expect(moved.row().phase).toBe("await_review"); expect(moved.row().reviewedHead).toBe("d".repeat(40));
  expect(moved.actions).toEqual(["inspect", "carry", "step:await_review"]);
});
for (const verdict of ["wait", { bounce: "train refusal" }, "cleared"] as const) {
  test(`train ${JSON.stringify(verdict)} retains precedence while required CI is unsettled`, async () => {
    const f = driverReady({ mergeState: "BEHIND" });
    f.external.train = async () => { f.actions.push("train"); return verdict; };
    await f.tick();
    if (typeof verdict === "object") {
      expect([f.row().phase, f.row().reason, f.actions]).toEqual(["resolved", "train refusal", ["inspect", "train", "step:resolved"]]);
    } else {
      expect([f.row().phase, f.actions]).toEqual(["ready", ["inspect", "train"]]);
    }
  });
}
for (const phase of ["updating", "await_ci"] as const) {
  test(`${phase} behavior is unchanged: same head UNSTABLE shard red with required pending`, async () => {
    const f = driverReady({}, phase); await f.tick();
    expect(f.row().phase).toBe(phase === "updating" ? "unknown" : "await_ci");
    expect(f.actions).toEqual(phase === "updating" ? ["inspect", "step:unknown"] : ["inspect"]);
    expect(f.row().reason).toBe(phase === "updating" ? "更新分支后 CI 失败或取消" : null);
  });
}
test("SchedulerStopped from inspection, train or phase claim propagates unchanged", async () => {
  const stop = new SchedulerStopped("lease lost");
  const a = driverReady(); a.external.inspect = async () => { throw stop; };
  await expect(a.tick()).rejects.toBe(stop);
  const b = driverReady(); b.external.train = async () => { throw stop; };
  await expect(b.tick()).rejects.toBe(stop);
  const c = driverReady({ mergeState: "UNKNOWN" });
  await expect(driveMerge(c.row(), c.external, async () => { throw stop; })).rejects.toBe(stop);
  expect([a.receipts, b.receipts, c.receipts]).toEqual([[], [], []]);
});
