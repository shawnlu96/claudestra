/** merge-arch-SELECT4 gh adapter of the read map's fuse: argv only, fake runner, no network. */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { trainGh } from "../src/lib/scheduler-merge-train-gh.js";

const REPO = "example/repo", H = "a".repeat(40);
const ok = (stdout = ""): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const err = (stderr: string, code = 1): BoundedResult => ({ code, stdout: "", stderr, timedOut: false });
function runner(answer: (argv: string[]) => BoundedResult) {
  const seen: string[][] = [];
  return { seen, gh: trainGh((async (argv: string[]) => { seen.push(argv); return answer(argv); }) as never) };
}
const run = (over: Record<string, unknown> = {}) => ({ id: 7, status: "completed", conclusion: "failure", head_branch: "train/1-a", head_sha: H, run_attempt: 2,
  path: ".github/workflows/ci.yml", event: "pull_request", repo: REPO, head_repo: REPO, prs: [3], ...over });

describe("merge-arch-SELECT4 fuse gh adapter", () => {
  test("the one write is `gh variable set CI_IO_MAP --body observe` on the given repo: neither name nor value is an argument", async () => {
    const r = runner(() => ok());
    await r.gh.lowerIoMapVar(REPO);
    expect(r.seen).toEqual([["gh", "variable", "set", "CI_IO_MAP", "-R", REPO, "--body", "observe"]]);
    await expect(runner(() => err("HTTP 403: Resource not accessible by integration")).gh.lowerIoMapVar(REPO)).rejects.toThrow(/HTTP 403/);
    for (const bad of ["", "repo", "a/b/c", "a/b --body on", "a/b?x=1"]) await expect(r.gh.lowerIoMapVar(bad)).rejects.toThrow(/仓库名不合法/);
    expect(r.seen).toHaveLength(1);
  });
  test("the variable is read by name; unset is null, any other failure is an error and never a value", async () => {
    const r = runner(() => ok("on\n"));
    expect(await r.gh.ioMapVar(REPO)).toBe("on");
    expect(r.seen[0]).toEqual(["gh", "api", `repos/${REPO}/actions/variables/CI_IO_MAP`, "--jq", ".value"]);
    expect(await runner(() => err("gh: Not Found (HTTP 404)")).gh.ioMapVar(REPO)).toBeNull();
    await expect(runner(() => err("HTTP 502")).gh.ioMapVar(REPO)).rejects.toThrow(/读 CI_IO_MAP 失败/);
    await expect(runner(() => ({ code: null, stdout: "on", stderr: "", timedOut: true })).gh.ioMapVar(REPO)).rejects.toThrow(/timeout/);
  });
  test("runs are read by exact id / attempt / head sha of ci.yml's pull_request runs; a shape that is off is an error", async () => {
    const r = runner((a) => ok(JSON.stringify(a[2]!.includes("head_sha=") ? [run()] : run())));
    expect(await r.gh.ciRun(REPO, 7, 2)).toEqual({ id: 7, attempt: 2, status: "completed", conclusion: "failure", branch: "train/1-a", head: H,
      path: ".github/workflows/ci.yml", event: "pull_request", repo: REPO, headRepo: REPO, prs: [3] });
    await r.gh.ciRun(REPO, 7);
    expect((await r.gh.headRuns(REPO, H))[0]!.prs).toEqual([3]);
    expect(r.seen.map((a) => a[2])).toEqual([`repos/${REPO}/actions/runs/7/attempts/2`, `repos/${REPO}/actions/runs/7`,
      `repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${H}&event=pull_request&per_page=100`]);
    await expect(r.gh.headRuns(REPO, "main")).rejects.toThrow(/完整 SHA/);
    await expect(runner(() => ok(JSON.stringify(run({ head_sha: null })))).gh.ciRun(REPO, 7)).rejects.toThrow(/run 输出无效/);
    expect((await runner(() => ok(JSON.stringify(run({ head_repo: null })))).gh.ciRun(REPO, 7)).headRepo).toBe(""); // a deleted fork is never "this repo"
  });
  test("an attempt's jobs must be listed whole; its failed log is read with --attempt and refused when it may be cut", async () => {
    const jobs = { total: 1, jobs: [{ id: 5, name: "ci scope related", status: "completed", conclusion: "success" }] };
    const r = runner((a) => ok(a[1] === "api" ? JSON.stringify(jobs) : "log"));
    expect(await r.gh.attemptJobs(REPO, 7, 2)).toEqual(jobs.jobs);
    expect(await r.gh.attemptFailedLog(REPO, 7, 2)).toBe("log");
    expect(r.seen.map((a) => a.slice(1, 4))).toEqual([["api", `repos/${REPO}/actions/runs/7/attempts/2/jobs?per_page=100`, "--jq"], ["run", "view", "7"]]);
    expect(r.seen[1]).toEqual(["gh", "run", "view", "7", "--attempt", "2", "-R", REPO, "--log-failed"]);
    await expect(runner(() => ok(JSON.stringify({ ...jobs, total: 140 }))).gh.attemptJobs(REPO, 7, 2)).rejects.toThrow(/没列全/);
    await expect(runner(() => ok("x".repeat(900 * 1024))).gh.attemptFailedLog(REPO, 7, 2)).rejects.toThrow(/可能被截断/);
  });
  test("the plan artifact is downloaded by run id into a fresh temp dir, read as text and the dir removed; a missing one is an error", async () => {
    let dir = "";
    const r = runner((a) => { dir = a[a.indexOf("-D") + 1]!; writeFileSync(join(dir, "plan.json"), '{"version":1}'); return ok(); });
    expect(await r.gh.planArtifact(REPO, 7)).toBe('{"version":1}');
    expect(r.seen[0]!.slice(0, 9)).toEqual(["gh", "run", "download", "7", "-R", REPO, "-n", "ci-related-plan", "-D"]);
    expect(existsSync(dir)).toBe(false);
    const none = runner((a) => { dir = a[a.indexOf("-D") + 1]!; return err("no artifact matches any of the names or patterns provided"); });
    await expect(none.gh.planArtifact(REPO, 7)).rejects.toThrow(/no artifact matches/);
    expect(existsSync(dir)).toBe(false);
  });
});
