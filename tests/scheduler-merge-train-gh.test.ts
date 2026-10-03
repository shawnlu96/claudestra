/** i28-MT1 gh adapter: argv only, fake runner, no network. */
import { describe, expect, test } from "bun:test";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { PR_FILES_CAP, trainGh } from "../src/lib/scheduler-merge-train-gh.js";

const H = "a".repeat(40), M = "c".repeat(40);
const ok = (stdout = ""): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const err = (stderr: string, code = 1): BoundedResult => ({ code, stdout: "", stderr, timedOut: false });

function runner(answer: (argv: string[]) => BoundedResult) {
  const seen: string[][] = [];
  const command = async (argv: string[]) => { seen.push(argv); return answer(argv); };
  return { seen, gh: trainGh(command as never) };
}

describe("i28-MT1 merge train gh adapter", () => {
  test("member merge is gh pr merge --merge --match-head-commit, then the merge commit is read back", async () => {
    const r = runner((a) => (a[1] === "pr" && a[2] === "view" ? ok(`${M}\n`) : ok()));
    expect(await r.gh.mergeMatchHead("https://github.com/example/repo/pull/7", H)).toBe(M);
    expect(r.seen[0]).toEqual(["gh", "pr", "merge", "https://github.com/example/repo/pull/7", "--merge", "--match-head-commit", H]);
  });
  test("branch writes refuse anything outside train/ before running gh", async () => {
    const r = runner(() => ok());
    for (const b of ["main", "feature/x", "train/../main", "train/"]) {
      await expect(r.gh.deleteBranch("example/repo", b)).rejects.toThrow(/非列车分支/);
      await expect(r.gh.createBranch("example/repo", b, H)).rejects.toThrow(/非列车分支/);
    }
    expect(r.seen).toEqual([]);
    await r.gh.deleteBranch("example/repo", "train/1-abc");
    expect(r.seen[0]).toEqual(["gh", "api", "-X", "DELETE", "repos/example/repo/git/refs/heads/train/1-abc"]);
  });
  test("an already-deleted branch is fine; any other delete failure is reported", async () => {
    expect(await runner(() => err("gh: Reference does not exist (HTTP 422)")).gh.deleteBranch("example/repo", "train/x")).toBeUndefined();
    await expect(runner(() => err("HTTP 500")).gh.deleteBranch("example/repo", "train/x")).rejects.toThrow(/删列车分支失败/);
  });
  test("a leftover train branch from a crash is forced back to the base", async () => {
    const r = runner((a) => (a.includes("POST") ? err("Reference already exists (HTTP 422)") : ok()));
    await r.gh.createBranch("example/repo", "train/1-abc", H);
    expect(r.seen[1]).toEqual(["gh", "api", "-X", "PATCH", "repos/example/repo/git/refs/heads/train/1-abc", "-f", `sha=${H}`, "-F", "force=true"]);
  });
  test("merges API: conflict is an answer, other failures throw", async () => {
    expect(await runner(() => err("Merge conflict (HTTP 409)")).gh.mergeInto("example/repo", "train/x", H, "m")).toBe("conflict");
    expect(await runner(() => ok("")).gh.mergeInto("example/repo", "train/x", H, "m")).toBe("merged");
    await expect(runner(() => err("HTTP 404")).gh.mergeInto("example/repo", "train/x", H, "m")).rejects.toThrow(/拼车合并失败/);
  });
  test("an open PR for the train branch is reused instead of opening a second one", async () => {
    const r = runner(() => ok("41\n"));
    expect(await r.gh.openDraft("example/repo", "train/x", "t", "b")).toBe(41);
    expect(r.seen).toHaveLength(1);
    const fresh = runner((a) => (a.includes("POST") ? ok("42\n") : ok("")));
    expect(await fresh.gh.openDraft("example/repo", "train/x", "t", "b")).toBe(42);
    expect(fresh.seen[1]).toContain("draft=true");
  });
  test("a PR at GitHub's file-list cap never joins a train; renames count both names", async () => {
    const many = Array.from({ length: PR_FILES_CAP }, (_, i) => `f${i}`).join("\n");
    expect(await runner(() => ok(many)).gh.prFiles("https://github.com/example/repo/pull/1")).toBeNull();
    expect(await runner(() => ok("a.ts\nold.ts\n")).gh.prFiles("https://github.com/example/repo/pull/1")).toEqual(["a.ts", "old.ts"]);
  });
  test("checks: pending exit 8 still parses; no checks yet reads as an empty list", async () => {
    const pending = runner(() => ({ code: 8, stdout: JSON.stringify([{ name: "check", bucket: "pending" }]), stderr: "", timedOut: false }));
    expect(await pending.gh.checks("example/repo", 5)).toEqual([{ name: "check", bucket: "pending" }]);
    expect(await runner(() => err("no checks reported on the 'train/x' branch")).gh.checks("example/repo", 5)).toEqual([]);
  });
  test("failed log summary keeps the tail of --log-failed without job / timestamp columns", async () => {
    const log = ["job\tstep\t2026-10-02T10:00:00.0000000Z ok", "job\tstep\t2026-10-02T10:00:01.0000000Z FAIL x > y"].join("\n");
    const r = runner(() => ok(log));
    expect(await r.gh.failLog("example/repo", "https://github.com/example/repo/actions/runs/77/job/1")).toBe("ok | FAIL x > y");
    expect(r.seen[0]).toEqual(["gh", "run", "view", "77", "-R", "example/repo", "--log-failed"]);
  });
});
