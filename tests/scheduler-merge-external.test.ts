import { describe, expect, test } from "bun:test";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const H = "a".repeat(40), M = "b".repeat(40);
const policy = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check", "Guard"],
  deploy: { cwd: "/tmp/project", argv: ["/usr/bin/true"], verifyArgv: ["verify", "--json"] } } } }).projects.p;
const row = { intentId: "i", taskId: "T1", prRef: "https://github.com/example/repo/pull/42", mergeSha: M } as MergeRun;

describe("T68 real merge adapter command boundary", () => {
  test("GitHub merge uses the expected reviewed head as an atomic API precondition", async () => {
    const calls: string[][] = [];
    const command: typeof runBounded = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: JSON.stringify({ merged: true, sha: M }), stderr: "", timedOut: false };
    };
    const ops = mergeExternal(policy, async () => ({ ok: true }), command);
    expect(await ops.merge(row.prRef, H)).toBe(M);
    expect(calls).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/42/merge", "-f", `sha=${H}`, "-f", "merge_method=merge"]]);
    await expect(ops.merge(row.prRef, "bad")).rejects.toThrow(/expected head/);
    expect(calls).toHaveLength(1);
  });
  test("deployment receipt must name the exact merge SHA", async () => {
    const command: typeof runBounded = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, mergeSha: H, receipt: "release-1" }),
      stderr: "", timedOut: false });
    const ops = mergeExternal(policy, async () => ({ ok: true }), command);
    expect(await ops.deployed(row)).toBeNull();
  });
});
