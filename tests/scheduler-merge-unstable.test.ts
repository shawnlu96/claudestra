import { describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";

const H = "a".repeat(40), M = "b".repeat(40), OTHER = "c".repeat(40);
const base: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/a/b/pull/1",
  reviewedHead: H, expectedBranch: "task/T1", requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null,
  reason: null, createdAt: 1, updatedAt: 1 };
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false,
  crossRepository: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });
const running = (p: Partial<PrSnapshot> = {}) => pr({ mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "pending" }], ...p });

/** inspect() returns the queued snapshots in order, repeating the last one. */
function fixture(phase: MergeRun["phase"], ...snapshots: PrSnapshot[]) {
  let row: MergeRun = { ...base, phase };
  const queue = [...snapshots];
  const calls: string[] = [];
  const ops: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return queue.length > 1 ? queue.shift()! : queue[0]!; },
    freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }), // i28-M9: never behind main here
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async (_, expectedHead) => {
      expect(expectedHead).toBe(H);
      calls.push("merge");
      queue.splice(0, queue.length, pr({ state: "MERGED", mergeSha: M }));
      return M;
    },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    calls.push(`journal:${to}`);
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    return row;
  };
  const drive = () => driveMerge(row, ops, advance);
  return { get row() { return row; }, calls, drive, queue };
}

const changes: [string, Partial<PrSnapshot>][] = [
  ["head", { head: OTHER }], ["base", { base: "dev" }], ["branch", { branch: "task/T2" }],
  ["draft", { draft: true }], ["cross-repo", { crossRepository: true }], ["closed", { state: "CLOSED" }],
];

describe("i28-M7 merge driver treats UNSTABLE (CI still running) as waiting, not unknown", () => {
  test("ready and updating: UNSTABLE with running CI enters await_ci like CLEAN", async () => {
    for (const phase of ["ready", "updating"] as const) {
      const f = fixture(phase, running());
      await f.drive();
      expect(f.row.phase).toBe("await_ci");
      expect(f.calls).toEqual(["inspect", "journal:await_ci"]);
    }
  });
  test("ready and updating: UNSTABLE with a failed or cancelled check (even non-required) is unknown", async () => {
    for (const phase of ["ready", "updating"] as const) {
      for (const bucket of ["fail", "cancel"] as const) {
        const f = fixture(phase, running({ checks: [{ name: "check", bucket: "pass" }, { name: "optional", bucket }] }));
        await f.drive();
        expect(f.row.phase).toBe("unknown");
        expect(f.row.reason).toContain("CI 失败或取消");
      }
    }
  });
  test("ready: UNSTABLE with changed base/branch/cross-repo/state is still unknown; a moved head alone returns to review (MCRY2)", async () => {
    const moved = fixture("ready", running({ head: OTHER }));
    await moved.drive();
    expect([moved.row.phase, moved.row.reason?.includes(OTHER.slice(0, 12))]).toEqual(["await_review", true]);
    for (const [, change] of changes.filter(([k]) => k !== "draft" && k !== "head")) {
      const f = fixture("ready", running(change));
      await f.drive();
      expect(f.row.phase).toBe("unknown");
    }
  });
  test("updating: UNSTABLE with a moved head returns to review; other changes are unknown", async () => {
    const moved = fixture("updating", running({ head: M }));
    await moved.drive();
    expect(moved.row.phase).toBe("await_review");
    for (const [, change] of changes.filter(([k]) => k !== "draft" && k !== "head")) {
      const f = fixture("updating", running(change));
      await f.drive();
      expect(f.row.phase).toBe("unknown");
    }
  });
  test("await_ci: UNSTABLE with pending or passing checks keeps waiting without journaling or merging", async () => {
    for (const checks of [[{ name: "check", bucket: "pending" as const }], [{ name: "check", bucket: "pass" as const }, { name: "x", bucket: "pending" as const }],
      [{ name: "check", bucket: "pass" as const }], []]) {
      const f = fixture("await_ci", running({ checks }));
      const before = f.row;
      expect(await f.drive()).toBe(before);
      expect(f.calls).toEqual(["inspect"]);
    }
  });
  test("await_ci: UNSTABLE with a failed or cancelled non-required check is unknown and never merges", async () => {
    // A failed *required* check is a bounce back to fix since i28-M12 (tests/scheduler-merge-conflict.test.ts).
    for (const checks of [[{ name: "check", bucket: "pass" as const }, { name: "lint", bucket: "fail" as const }],
      [{ name: "check", bucket: "pending" as const }, { name: "lint", bucket: "cancel" as const }]]) {
      const f = fixture("await_ci", running({ checks }));
      await f.drive();
      expect(f.row.phase).toBe("unknown");
      expect(f.row.reason).toContain("CI 失败或取消");
      expect(f.calls).not.toContain("merge");
    }
  });
  test("await_ci: UNSTABLE with any of head/base/branch/draft/cross-repo/state changed is unknown, not waiting", async () => {
    for (const [name, change] of changes) {
      const f = fixture("await_ci", running(change));
      await f.drive();
      expect([name, f.row.phase]).toEqual([name, name === "head" ? "await_review" : "unknown"]); // MCRY3: an author push re-reviews
      expect(f.calls).not.toContain("merge");
    }
  });
  test("await_ci: UNSTABLE with the PR turned draft is unknown; a CLEAN draft keeps the existing draft-wait", async () => {
    for (const change of [{ draft: true }, { draft: true, head: OTHER }]) {
      const f = fixture("await_ci", running(change));
      await f.drive();
      expect(f.row.phase).toBe("unknown");
      expect(f.calls).not.toContain("merge");
    }
    const clean = fixture("await_ci", pr({ draft: true }));
    await clean.drive();
    expect(clean.calls).toEqual(["inspect"]);
  });
  test("UNSTABLE while CI runs, then CLEAN and green: ready → await_ci → wait → merged", async () => {
    const f = fixture("ready", running(), running(), pr());
    await f.drive();
    expect(f.row.phase).toBe("await_ci");
    await f.drive();
    expect(f.row.phase).toBe("await_ci");
    await f.drive();
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toEqual(["inspect", "journal:await_ci", "inspect", "inspect", "inspect", "journal:merging", "merge", "inspect", "journal:merged"]);
  });
  test("final pre-merge check is not relaxed: CLEAN then UNSTABLE on re-inspect is unknown without merging", async () => {
    const f = fixture("await_ci", pr(), running({ checks: [{ name: "check", bucket: "pass" }] }));
    await f.drive();
    expect(f.row.phase).toBe("unknown");
    expect(f.row.reason).toContain("合并前最后一次核对");
    expect(f.calls).not.toContain("merge");
  });
  test("UNSTABLE with all checks passing never enters merging (merging still requires CLEAN)", async () => {
    const f = fixture("await_ci", running({ checks: [{ name: "check", bucket: "pass" }] }));
    await f.drive();
    expect(f.row.phase).toBe("await_ci");
    expect(f.calls).not.toContain("journal:merging");
  });
});
