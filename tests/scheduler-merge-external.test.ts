import { describe, expect, test } from "bun:test";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const H = "a".repeat(40), M = "b".repeat(40);
const policy = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check", "Guard"],
  repoDir: "/tmp/project" } } }).projects.p;
const row = { prRef: "https://github.com/example/repo/pull/42" };

describe("T68 real merge adapter command boundary", () => {
  test("draft metadata is returned without querying absent or pending checks", async () => {
    const calls: string[][] = [];
    const command: typeof runBounded = async (argv) => {
      calls.push(argv);
      if (argv[1] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "", timedOut: false };
      if (argv[2] === "view") return { code: 0, stderr: "", timedOut: false, stdout: JSON.stringify({
        state: "OPEN", headRefOid: H, headRefName: "task/T1", baseRefName: "main", isDraft: true,
        isCrossRepository: false, mergeStateStatus: "UNKNOWN", mergeCommit: null,
      }) };
      throw new Error("draft must not run gh pr checks");
    };
    const snapshot = await mergeExternal(policy, command).inspect(row.prRef);
    expect(snapshot.draft).toBe(true);
    expect(snapshot.checks).toEqual([]);
    expect(calls).toHaveLength(2);
  });
  test("GitHub merge uses the expected reviewed head as an atomic API precondition", async () => {
    const calls: string[][] = [];
    const command: typeof runBounded = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: JSON.stringify({ merged: true, sha: M }), stderr: "", timedOut: false };
    };
    const ops = mergeExternal(policy, command);
    expect(await ops.merge(row.prRef, H)).toBe(M);
    expect(calls).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/42/merge", "-f", `sha=${H}`, "-f", "merge_method=merge"]]);
    await expect(ops.merge(row.prRef, "bad")).rejects.toThrow(/expected head/);
    expect(calls).toHaveLength(1);
  });
});
