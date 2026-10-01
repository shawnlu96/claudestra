import { describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";

const H = "a".repeat(40), M = "b".repeat(40);
const base: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/a/b/pull/1",
  reviewedHead: H, expectedBranch: "task/T1", requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null,
  reason: null, createdAt: 1, updatedAt: 1 };
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });

function fixture(initial = base) {
  let row = { ...initial }, snapshot = pr();
  const calls: string[] = [];
  const ops: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return snapshot; },
    freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }), // i28-M9: never behind main here
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async (_, expectedHead) => { expect(expectedHead).toBe(H); calls.push("merge"); snapshot = pr({ state: "MERGED", mergeSha: M }); return M; },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    if (to === "await_review") expect(newHead).toBe(M);
    calls.push(`journal:${to}`);
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    return row;
  };
  return { get row() { return row; }, get snapshot() { return snapshot; }, set snapshot(x: PrSnapshot) { snapshot = x; }, calls, ops, advance };
}

describe("T68 merge driver", () => {
  test("losing ownership during final inspection cannot merge or freeze the replacement's run", async () => {
    const f = fixture({ ...base, phase: "await_ci" });
    let active = true, reads = 0;
    f.ops.inspect = async () => { if (++reads === 2) active = false; return pr(); };
    await expect(driveMerge(f.row, f.ops, f.advance, () => {
      if (!active) throw new SchedulerStopped("lease lost");
    })).rejects.toThrow(/lease lost/);
    expect(f.row.phase).toBe("await_ci");
    expect(f.calls).not.toContain("merge");
    expect(f.calls).not.toContain("journal:unknown");
  });
  test("required checks match gh job names verbatim, case and spaces included", async () => {
    const names = ["typecheck + test + guard", "web typecheck + lint", "desktop typecheck + cargo test"];
    const checks = names.map((name) => ({ name, bucket: "pass" as const }));
    const ok = fixture({ ...base, phase: "await_ci", requiredChecks: names.join(",") });
    ok.snapshot = pr({ checks });
    await driveMerge(ok.row, ok.ops, ok.advance, () => {});
    expect(ok.row.phase).toBe("merged");
    const off = fixture({ ...base, phase: "await_ci", requiredChecks: ["Typecheck + test + guard", ...names.slice(1)].join(",") });
    off.snapshot = pr({ checks });
    await driveMerge(off.row, off.ops, off.advance, () => {});
    expect(off.calls).not.toContain("merge");
    expect(off.row.phase).toBe("await_ci");
  });
  test("draft waits for this card without freezing the project or issuing effects", async () => {
    for (const phase of ["ready", "updating", "await_ci"] as const) {
      const f = fixture({ ...base, phase });
      f.snapshot = pr({ draft: true });
      await driveMerge(f.row, f.ops, f.advance);
      expect(f.row.phase).toBe(phase);
      expect(f.calls).toEqual(["inspect"]);
    }
  });
  test("CI and exact head are checked before merge; effects are journaled first; merged is terminal", async () => {
    const f = fixture();
    await driveMerge(f.row, f.ops, f.advance);
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toEqual(["inspect", "journal:await_ci", "inspect", "inspect", "journal:merging", "merge", "inspect", "journal:merged"]);
    expect(f.row.reason).toContain("待 PM 部署");
    const settled = f.calls.length;
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toHaveLength(settled); // No inspect, no deployment: the PM deploys by hand.
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
  test("fork PR at the same head is not eligible for merge", async () => {
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
    expect(f.calls).toEqual(["inspect", "journal:ready"]);
  });
  test("restart in merging reconciles; an open PR freezes without retry", async () => {
    const f = fixture({ ...base, phase: "merging", rev: 3 });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("unknown");
    expect(f.calls).not.toContain("merge");
  });
  test("a retargeted PR after merge freezes instead of reporting merged", async () => {
    const f = fixture({ ...base, phase: "merging", rev: 3 });
    f.snapshot = pr({ state: "MERGED", base: "other", mergeSha: M });
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row.phase).toBe("unknown");
  });
  test("restart in merging with a verified merge reaches merged without calling merge again", async () => {
    const f = fixture({ ...base, phase: "merging", rev: 3 });
    f.snapshot = pr({ state: "MERGED", mergeSha: M });
    await driveMerge(f.row, f.ops, f.advance);
    expect([f.row.phase, f.row.mergeSha]).toEqual(["merged", M]);
    expect(f.calls).not.toContain("merge");
  });
});
