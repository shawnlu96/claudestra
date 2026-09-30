import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentJobs, readDeployJob } from "../src/lib/scheduler-deploy-job.js";
import type { DeployRun } from "../src/lib/scheduler-deploy.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { SRC_DIR } from "../src/lib/repo-root.js";

const SHA = "d".repeat(40);
const run = { intentId: "m9", taskId: "T9", prRef: "https://github.com/a/b/pull/7", mergeSha: SHA } as DeployRun;
const target = { restartLabels: ["x.fake.one"], timeoutMs: 60_000 };
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A fake launchctl: `state` says what `launchctl list <label>` answers. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t68g-job-")); roots.push(root);
  const calls: string[][] = [];
  const f = { root, calls, time: 1_000_000, state: "running" as "running" | "loaded" | "absent" | "hung" };
  const command: typeof runBounded = async (argv) => {
    calls.push(argv);
    const ok = { code: 0, timedOut: false, stderr: "", stdout: "" };
    if (argv[1] === "list") {
      if (f.state === "hung") return { ...ok, code: null, timedOut: true };
      if (f.state === "absent") return { ...ok, code: 113, stderr: "Could not find service" };
      return { ...ok, stdout: f.state === "running" ? `{\n\t"PID" = 4242;\n};` : `{\n\t"LastExitStatus" = 0;\n};` };
    }
    return ok;
  };
  const jobs = deploymentJobs({ root: join(root, "jobs"), command, now: () => f.time, uid: 501 });
  const dir = () => join(root, "jobs", readdirSync(join(root, "jobs"))[0]);
  return { ...f, f, jobs, dir };
}

describe("T68g deploy job (launchd)", () => {
  test("P1 reload: the deploy is its own launchd job running scheduler.ts --deploy-job, never a scheduler child; submitted once", async () => {
    const x = fixture();
    const label = await x.jobs.submit(run, "/repo", target);
    expect(label).toMatch(/^com\.claudestra\.scheduler\.deploy\.[a-f0-9]{32}$/);
    const plist = readFileSync(join(x.dir(), "job.plist"), "utf8");
    expect(plist).toContain(`<string>${join(SRC_DIR, "scheduler.ts")}</string>`);
    expect(plist).toContain("<string>--deploy-job</string>");
    expect(plist).toMatch(/<key>KeepAlive<\/key><false\/>/);
    expect(x.calls.filter((a) => a[1] === "bootstrap")).toEqual([["/bin/launchctl", "bootstrap", "gui/501", join(x.dir(), "job.plist")]]);
    expect(await x.jobs.submit(run, "/repo", target)).toBe(label); // existing claim: observed, not submitted again
    expect(x.calls.filter((a) => a[1] === "bootstrap")).toHaveLength(1);
    expect(readDeployJob(join(x.dir(), "request.json"))).toMatchObject({ mergeSha: SHA, repoDir: "/repo", relayArgv: null });
  });

  test("never claimed → null only when launchd also has no such job; launchd running → alive; unreadable → unreadable, not dead", async () => {
    const x = fixture();
    x.f.state = "absent";
    expect(await x.jobs.observe(run)).toBeNull();
    x.f.state = "hung";
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "unreadable", corrupt: expect.stringMatching(/目录丢失/) });
    x.f.state = "running";
    await x.jobs.submit(run, "/repo", target);
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "alive", result: null });
    x.f.state = "hung";
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "unreadable", result: null });
  });

  test("P1 killed by a reload: no result + gone from launchd + stale lease → dead with no result (outcome unknown, checked)", async () => {
    const x = fixture();
    await x.jobs.submit(run, "/repo", target);
    const lock = join(x.root, "maint.lock");
    mkdirSync(lock); writeFileSync(join(lock, "owner"), "tok");
    writeFileSync(join(x.dir(), "lease.json"), JSON.stringify({ path: lock, token: "tok" }));
    x.f.state = "absent";
    const t = new Date(); utimesSync(lock, t, t);
    x.f.time = Date.now();
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "alive" }); // lease still fresh: a job may be between renewals
    x.f.time = Date.now() + 120_000;
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "dead", result: null });
  });

  test("result is read with liveness: a finished job that is still exiting is not judged yet", async () => {
    const x = fixture();
    await x.jobs.submit(run, "/repo", target);
    writeFileSync(join(x.dir(), "result.json"), JSON.stringify({ intentId: "m9", mergeSha: SHA, ok: true, summary: "done" }));
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "alive", result: { ok: true } });
    x.f.state = "loaded";
    expect(await x.jobs.observe(run)).toMatchObject({ liveness: "dead", result: { ok: true, summary: "done" } });
    writeFileSync(join(x.dir(), "result.json"), JSON.stringify({ intentId: "other", mergeSha: SHA, ok: true }));
    expect(await x.jobs.observe(run)).toMatchObject({ result: null, corrupt: expect.stringMatching(/identity/) });
  });

  test("an unreadable request.json never wedges running: the label follows from the directory, the deadline counts as passed", async () => {
    const x = fixture();
    const label = await x.jobs.submit(run, "/repo", target);
    writeFileSync(join(x.dir(), "request.json"), "{ torn");
    expect(await x.jobs.observe(run)).toMatchObject({ label, liveness: "alive", result: null, corrupt: expect.stringMatching(/request\.json/) });
    expect((await x.jobs.observe(run))!.deadline).toBeLessThan(x.f.time);
    x.f.state = "absent";
    expect(await x.jobs.observe(run)).toMatchObject({ label, liveness: "dead", result: null });
  });

  test("r4-P1-1: a missing request.json or job directory is never read as 'not submitted'; the label is checked with launchd", async () => {
    const x = fixture();
    const label = await x.jobs.submit(run, "/repo", target);
    rmSync(join(x.dir(), "request.json"));
    expect(await x.jobs.observe(run)).toMatchObject({ label, liveness: "alive", result: null, corrupt: expect.stringMatching(/missing/) });
    expect(await x.jobs.submit(run, "/repo", target)).toBe(label); // the claim stands; nothing is bootstrapped again
    expect(x.calls.filter((a) => a[1] === "bootstrap")).toHaveLength(1);
    rmSync(join(x.root, "jobs"), { recursive: true });
    expect(await x.jobs.observe(run)).toMatchObject({ label, liveness: "alive", deadline: 0 });
    expect(x.calls.at(-1)).toEqual(["/bin/launchctl", "list", label]);
    x.f.state = "absent";
    expect(await x.jobs.observe(run)).toBeNull();
  });

  test("remove only touches deploy labels and treats 'already gone' as done", async () => {
    const x = fixture();
    await expect(x.jobs.remove("com.claudestra.bridge")).rejects.toThrow(/non-deploy/);
    const label = await x.jobs.submit(run, "/repo", target);
    expect(await x.jobs.remove(label)).toBe(true);
    expect(x.calls.at(-1)).toEqual(["/bin/launchctl", "bootout", `gui/501/${label}`]);
  });
});
