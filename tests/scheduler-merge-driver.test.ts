import { describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";

const H = "a".repeat(40), M = "b".repeat(40);
const base: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/a/b/pull/1",
  reviewedHead: H, expectedBranch: "task/T1", requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null, deployReceipt: null, verifyReceipt: null,
  reason: null, createdAt: 1, updatedAt: 1 };
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });

function fixture(initial = base) {
  let row = { ...initial }, snapshot = pr();
  const calls: string[] = [];
  const ops: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return snapshot; },
    updateBranch: async () => { calls.push("update"); },
    merge: async (_, expectedHead) => { expect(expectedHead).toBe(H); calls.push("merge"); snapshot = pr({ state: "MERGED", mergeSha: M }); return M; },
    deploy: async () => { calls.push("deploy"); return "sent"; },
    deployed: async () => { calls.push("deployed"); return "release-b"; },
    verifyLedger: async () => { calls.push("verify"); return "ledger-verified"; },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    if (to === "await_review") expect(newHead).toBe(M);
    calls.push(`journal:${to}`);
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null,
      mergeSha: mergeSha ?? row.mergeSha, deployReceipt: to === "deployed" ? receipt ?? null : row.deployReceipt,
      verifyReceipt: to === "done" ? receipt ?? null : row.verifyReceipt };
    return row;
  };
  return { get row() { return row; }, get snapshot() { return snapshot; }, set snapshot(x: PrSnapshot) { snapshot = x; }, calls, ops, advance };
}

describe("T68 merge driver", () => {
  test("CI and exact head are checked before merge; effects are journaled first", async () => {
    const f = fixture();
    await driveMerge(f.row, f.ops, f.advance);
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toEqual(["inspect", "journal:await_ci", "inspect", "journal:merging", "inspect", "merge", "journal:merged"]);
    await driveMerge(f.row, f.ops, f.advance);
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("done");
    expect(f.calls.indexOf("journal:deploying")).toBeLessThan(f.calls.indexOf("deploy"));
    expect(f.calls.indexOf("journal:verifying")).toBeLessThan(f.calls.indexOf("verify"));
  });
  test("branch update changing head requires another review", async () => {
    const f = fixture();
    f.snapshot = pr({ mergeState: "BEHIND" });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("updating");
    f.snapshot = pr({ head: M });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("await_review");
    expect(f.calls).not.toContain("merge");
  });
  test("another PR branch at the same head cannot enter CI or merge", async () => {
    const f = fixture();
    f.snapshot = pr({ branch: "task/other" });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("unknown");
    expect(f.calls).not.toContain("merge");
  });
  test("fork PR at the same head is not eligible for local deployment", async () => {
    const f = fixture();
    f.snapshot = pr({ crossRepository: true });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("unknown");
  });
  test("an unrelated pass cannot replace a missing or skipped required Guard check", async () => {
    const f = fixture({ ...base, phase: "await_ci", rev: 2, requiredChecks: "check,Guard" });
    f.snapshot = pr({ checks: [{ name: "check", bucket: "pass" }, { name: "Guard", bucket: "skipping" }, { name: "lint", bucket: "pass" }] });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("await_ci");
    f.snapshot = pr({ checks: [{ name: "check", bucket: "pass" }, { name: "lint", bucket: "pass" }] });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("await_ci");
    expect(f.calls).not.toContain("merge");
  });
  test("GitHub mergeability UNKNOWN is observed again without issuing an external effect", async () => {
    const f = fixture();
    f.snapshot = pr({ mergeState: "UNKNOWN" });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("ready");
    expect(f.calls).toEqual(["inspect"]);
  });
  test("restart in merging reconciles; an open PR freezes without retry", async () => {
    const f = fixture({ ...base, phase: "merging", rev: 3 });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("unknown");
    expect(f.calls).not.toContain("merge");
  });
  test("restart in deploying observes deployment without rerunning it", async () => {
    const f = fixture({ ...base, phase: "deploying", rev: 5, mergeSha: M });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("deployed");
    expect(f.calls).not.toContain("deploy");
  });
});
