import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentJobs, readDeployJob } from "../src/lib/scheduler-deploy-job.js";
import { runDeployJob } from "../src/lib/scheduler-deploy-worker.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { SRC_DIR } from "../src/lib/repo-root.js";

const roots: string[] = [], sha = "a".repeat(40);
const row = { intentId: "i", taskId: "T1", prRef: "https://github.com/a/b/pull/1", mergeSha: sha } as MergeRun;
const target = { cwd: "/tmp", argv: ["/usr/bin/true"], verifyArgv: ["/usr/bin/true"], timeoutMs: 1000 };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t68-deploy-test-")); roots.push(root);
  const calls: string[][] = [];
  let live = true, time = 1000;
  const command: typeof runBounded = async (argv) => {
    calls.push(argv);
    const label = calls.find((a) => a[1] === "submit")?.[3];
    return { code: 0, timedOut: false, stderr: "", stdout: live && label ? `123\t0\t${label}\n` : "" };
  };
  const jobs = deploymentJobs({ root, command, now: () => time });
  const requestPath = () => join(root, readdirSync(root).find((name) => /^[a-f0-9]{64}$/.test(name))!, "request.json");
  return { root, jobs, calls, requestPath, stop: () => { live = false; time = 20_000; } };
}

describe("independent deployment job", () => {
  test("sandbox deployment inherits the isolated port instead of falling back to production", async () => {
    const f = fixture(), state = join(f.root, "state"), runtime = join(f.root, "runtime");
    mkdirSync(state); mkdirSync(runtime);
    const env = { CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_SANDBOX: "1",
      CLAUDESTRA_SANDBOX_ROOT: f.root, BRIDGE_PORT: "9" };
    const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, env);
      await f.jobs.submit(row, { ...target, timeoutMs: 3000, argv: [process.execPath, "--no-env-file", "-e",
        `await import(${JSON.stringify(join(SRC_DIR, "lib/paths.ts"))});`] });
      await runDeployJob(f.requestPath());
      expect(await f.jobs.observe(row)).toEqual({ status: "complete" });
    } finally {
      for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
  test("submit uses launchd, restart observes running job, replay never launches a second command", async () => {
    const f = fixture();
    const label = await f.jobs.submit(row, target);
    expect(f.calls[1].slice(0, 4)).toEqual(["/bin/launchctl", "submit", "-l", label]);
    expect(f.calls[1]).toContain("--deploy-job");
    expect(await f.jobs.observe(row)).toEqual({ status: "running" });
    await deploymentJobs({ root: f.root }).submit(row, target);
    expect(f.calls.filter((a) => a[1] === "submit")).toHaveLength(1);
    const job = readDeployJob(f.requestPath());
    expect(Object.keys(job.env).some((k) => /TOKEN|KEY|DISCORD/.test(k))).toBe(false);
  });
  test("worker records result before exit and duplicate worker cannot execute twice", async () => {
    const f = fixture(); await f.jobs.submit(row, target);
    let executions = 0;
    await runDeployJob(f.requestPath(), async (_, opts) => {
      executions++; expect(opts.env?.CLAUDESTRA_MERGE_SHA).toBe(sha);
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    });
    f.stop();
    expect(await f.jobs.observe(row)).toEqual({ status: "complete" });
    await expect(runDeployJob(f.requestPath(), async () => { executions++; throw new Error("must not run"); })).rejects.toThrow();
    expect(executions).toBe(1);
    expect(JSON.parse(readFileSync(join(f.requestPath(), "../result.json"), "utf8")).mergeSha).toBe(sha);
  });
  test("disappeared job and corrupt or wrong-SHA result cannot be retried or declared deployed", async () => {
    const f = fixture(); await f.jobs.submit(row, target); f.stop();
    expect((await f.jobs.observe(row)).status).toBe("unknown");
    const result = join(f.requestPath(), "../result.json");
    writeFileSync(result, "{"); expect((await f.jobs.observe(row)).status).toBe("unknown");
    writeFileSync(result, JSON.stringify({ intentId: "i", mergeSha: "b".repeat(40), code: 0, timedOut: false }));
    expect((await f.jobs.observe(row)).status).toBe("unknown");
    await expect(f.jobs.submit({ ...row, mergeSha: "b".repeat(40) }, target)).rejects.toThrow(/identity/);
    expect(f.calls.filter((a) => a[1] === "submit")).toHaveLength(1);
  });
  test("nonzero and timed-out results remain failed even if a verifier could see old artifacts", async () => {
    const f = fixture(); await f.jobs.submit(row, target);
    await runDeployJob(f.requestPath(), async () => ({ code: null, timedOut: true, stdout: "", stderr: "timeout" }));
    expect((await f.jobs.observe(row)).status).toBe("failed");
  });
});
