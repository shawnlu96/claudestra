import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireDeployLock, waitingDeployLabels, readDeployLock } from "../src/lib/pm-deploy-lock.js";
import { runDeployJob } from "../src/lib/scheduler-deploy-worker.js";
import { schedulerMachineLock } from "../src/lib/scheduler-deploy-lock.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import type { DeployJob } from "../src/lib/scheduler-deploy-job.js";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.machine-events.json`, { force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "deploy-machine-")); roots.push(root);
  const path = join(root, "machine.lock"), request = join(root, "request.json");
  const job: DeployJob = { intentId: "i", taskId: "T1", mergeSha: "a".repeat(40), prRef: "https://github.com/a/b/pull/1",
    label: `com.claudestra.scheduler.deploy.${"b".repeat(32)}`, repoDir: "/repo", relayArgv: null,
    restartLabels: ["test.fake"], timeoutMs: 600000, createdAt: Date.now(), env: {} };
  writeJsonAtomicSync(request, job); return { root, path, request, job };
}
describe("machine deployment lock", () => {
  test("[验收线 1] a deploy-full holder defers the worker before every command", async () => {
    const f = fixture(), holder = await acquireDeployLock({ path: f.path, label: "deploy-full", waitMs: 0 });
    expect(holder.kind).toBe("acquired"); let commands = 0, released = false;
    try {
      const result = await runDeployJob(f.request, { machine: { path: f.path, enabled: true },
        acquire: async () => ({ path: "/lease", token: "t", held: () => true, release: () => { released = true; } }),
        run: async () => { commands++; throw new Error("must not execute"); } });
      expect(result).toMatchObject({ status: "deferred", ok: false, steps: [] });
      expect(JSON.parse(readFileSync(join(f.root, "result.json"), "utf8"))).toMatchObject({ status: "deferred" });
      expect(commands).toBe(0); expect(released).toBe(true);
    } finally { if (holder.kind === "acquired") holder.handle.release(); }
  });
  test("[验收线 2] only another valid waiting label changes SIGTERM to deferred", async () => {
    const f = fixture(), lock = await schedulerMachineLock(f.job, f.request, { path: f.path, enabled: true, waiting: () => ["deploy-full"] });
    expect(lock.term()).toMatchObject({ status: "deferred" }); lock.release();
    const idle = await schedulerMachineLock(f.job, f.request, { path: f.path, enabled: true, waiting: () => [] });
    expect(idle.term()).toBeNull(); idle.release();
  });
  test("[验收线 3] off never calls the machine lock port or writes samples", async () => {
    const f = fixture();
    const lock = await schedulerMachineLock(f.job, f.request, { enabled: false, acquireMachine: async () => { throw new Error("off"); } });
    expect(lock.blocked).toBeNull(); expect(lock.term()).toBeNull(); lock.release();
    expect(() => readFileSync(`${f.root}.machine-events.json`)).toThrow();
  });
  test("[验收线 7] unconfigured center authority is observe", () => {
    const f = fixture(); expect(recoveryPolicy("p", "centerDeployAuto", join(f.root, "missing.json")).mode).toBe("observe");
  });
  test("waiter records accept live labels, ignore missing labels and reject malformed labels", async () => {
    const f = fixture(), held = await acquireDeployLock({ path: f.path, label: "deploy-full", waitMs: 0 });
    if (held.kind !== "acquired") throw new Error("lock missing");
    try {
      mkdirSync(`${f.path}.waiters`);
      for (const [name, label] of [["live", "deploy-full"], ["old", undefined], ["bad", "bad\nlabel"]]) {
        writeFileSync(join(`${f.path}.waiters`, name!), JSON.stringify({ ...held.handle.record, label }));
      }
      expect(waitingDeployLabels(f.path)).toEqual(["deploy-full"]);
      expect(readDeployLock(join(`${f.path}.waiters`, "old")).status).toBe("ok");
      expect(readDeployLock(join(`${f.path}.waiters`, "bad")).status).toBe("corrupt");
    } finally { held.handle.release(); }
  });
});

test("[验收线 1] deferred keeps the journal running, never freezes, and resubmits the original claim", async () => {
  const { mergedCard } = await import("./deploy-test-kit.js");
  const { deploymentJobs } = await import("../src/lib/scheduler-deploy-job.js");
  const { beginDeployRun, advanceDeployRun, getDeployRun } = await import("../src/lib/scheduler-deploy.js");
  const { deferredDeployTick, deployJobDir } = await import("../src/lib/scheduler-deploy-lock-jobs.js");
  const { getMeta } = await import("../src/lib/ledger-store.js");
  const f = mergedCard();
  try {
    const root = join(f.dir, "jobs"); let submits = 0, now = 1000, todos = 0;
    const jobs = deploymentJobs({ root, command: async (a) => {
      if (a.includes("bootstrap")) { submits++; return { code: 0, timedOut: false, stdout: "", stderr: "" }; }
      return { code: 113, timedOut: false, stdout: "", stderr: "" };
    } });
    const claim = beginDeployRun(f.db, { actor: "scheduler" }, f.intent).run;
    const run = advanceDeployRun(f.db, { actor: "scheduler" }, { intentId: claim.intentId, from: "claimed", to: "running", rev: claim.rev, label: jobs.label(claim) });
    const target = { restartLabels: ["test.fake"], timeoutMs: 60_000 };
    await jobs.submit(run, "/repo", target);
    const markDeferred = () => writeJsonAtomicSync(join(deployJobDir(run, root), "result.json"), {
      intentId: run.intentId, mergeSha: run.mergeSha, ok: false, status: "deferred", summary: "deploy-full" });
    markDeferred();
    const d = { jobs, now: () => now, assertActive: () => {}, manager: async (...a: string[]) => {
      if (a[1] === "scheduler-pm-todo") todos++; else throw new Error(`unexpected write ${a[1]}`); return { ok: true };
    } };
    expect(await deferredDeployTick(d, run, await jobs.observe(run), root)).toBe(true);
    expect(getDeployRun(f.db, run.intentId)?.phase).toBe("running"); expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
    expect(submits).toBe(2); expect(todos).toBe(0);
    now += 3_600_000; markDeferred(); await deferredDeployTick(d, run, await jobs.observe(run), root); expect(todos).toBe(1);
    writeJsonAtomicSync(join(deployJobDir(run, root), "result.json"), { intentId: run.intentId, mergeSha: run.mergeSha, ok: true, summary: "done" });
    expect(await deferredDeployTick(d, run, await jobs.observe(run), root)).toBe(false);
    advanceDeployRun(f.db, { actor: "scheduler" }, { intentId: run.intentId, from: "running", to: "deployed", rev: run.rev,
      outcome: "success", liveness: "dead", receipt: "done" });
    expect(getDeployRun(f.db, run.intentId)?.phase).toBe("deployed"); expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
  } finally { f.close(); }
});

test("[验收线 2] actual SIGTERM writes deferred only with a waiting PM, releases the machine lock", async () => {
  for (const waiting of [true, false]) {
    const f = fixture();
    const source = `
      import { runDeployJob } from ${JSON.stringify(new URL("../src/lib/scheduler-deploy-worker.ts", import.meta.url).pathname)};
      await runDeployJob(${JSON.stringify(f.request)}, {
        machine: { enabled: true, path: ${JSON.stringify(f.path)}, waiting: () => ${JSON.stringify(waiting ? ["deploy-full"] : [])} },
        acquire: async () => ({ path: '/fake', token: 't', held: () => true, release() {} }),
        run: async () => { process.kill(process.pid, 'SIGTERM'); await Bun.sleep(10000); throw new Error('not reached'); }
      });
    `;
    const proc = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(143);
    const result = JSON.parse(readFileSync(join(f.root, "result.json"), "utf8"));
    expect(result.status).toBe(waiting ? "deferred" : undefined); expect(result.ok).toBe(false);
    expect(readDeployLock(f.path).status).toBe("missing");
  }
});

test("[验收线 3] machine locking defaults on even when another recovery key is configured; explicit off rolls back", async () => {
  const { machineLockEnabled } = await import("../src/lib/scheduler-deploy-lock.js");
  const f = fixture(), path = join(f.root, "policy.json");
  expect(machineLockEnabled("p", path)).toBe(true);
  writeJsonAtomicSync(path, { projects: { p: { keys: { centerDeployAuto: "observe" } } } });
  expect(machineLockEnabled("p", path)).toBe(true);
  writeJsonAtomicSync(path, { projects: { p: { keys: { deployMachineLock: "off" } } } });
  expect(machineLockEnabled("p", path)).toBe(false);
});

test("[验收线 1] the actual deploy tick consumes a deferred worker result without unknown or a new intent", async () => {
  const { mergedCard } = await import("./deploy-test-kit.js");
  const { deploymentJobs } = await import("../src/lib/scheduler-deploy-job.js");
  const { deployJobDir } = await import("../src/lib/scheduler-deploy-lock-jobs.js");
  const { deployTick } = await import("../src/lib/scheduler-deploy-tick.js");
  const { getDeployRun } = await import("../src/lib/scheduler-deploy.js");
  const { getMeta } = await import("../src/lib/ledger-store.js");
  const { runLedger } = await import("../src/manager/ledger.js");
  const f = mergedCard(), machine = join(f.dir, "machine.lock"); let submits = 0, commands = 0;
  const holder = await acquireDeployLock({ path: machine, label: "deploy-full", waitMs: 0 });
  if (holder.kind !== "acquired") throw new Error("missing holder");
  const dir = deployJobDir({ intentId: f.intent });
  try {
    const jobs = deploymentJobs({ command: async (a) => {
      if (a.includes("bootstrap")) {
        submits++;
        if (submits === 1) await runDeployJob(join(dir, "request.json"), { machine: { path: machine, enabled: true },
          acquire: async () => ({ path: "/lease", token: "t", held: () => true, release() {} }),
          run: async () => { commands++; throw new Error("no step while busy"); } });
        else writeJsonAtomicSync(join(dir, "result.json"), { intentId: f.intent, mergeSha: "d".repeat(40), ok: true, summary: "done" });
        return { code: 0, timedOut: false, stdout: "", stderr: "" };
      }
      return { code: 113, timedOut: false, stdout: "", stderr: "" };
    } });
    // Finish the fake verify so its process-wide retry throttle cannot escape this fixture.
    const verifies: string[] = [];
    const manager = async (...args: string[]) => args[1] === "verify" ? (verifies.push(args.slice(2).join(" ")), { ok: true, result: "pass" }) : runLedger(args.slice(1), {
      db: f.db, actor: "scheduler", projectIds: ["p"], now: () => 1000, assertLease() {},
      loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} });
    const cfg = { enabled: true, autoDispatch: true, pollMs: 5000, projects: { p: { repoDir: "/repo", maxActiveWorkers: 2,
      requiredChecks: [], deploy: { restartLabels: ["test.fake"], timeoutMs: 60_000 } } } };
    const d = { manager, jobs, now: () => 1000, assertActive() {}, center: { config: () => null } };
    await deployTick(f.db, cfg, d); expect(commands).toBe(0); expect(getDeployRun(f.db, f.intent)?.phase).toBe("running");
    holder.handle.release(); await deployTick(f.db, cfg, d);
    expect(submits).toBe(2); expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
    await deployTick(f.db, cfg, d); expect(getDeployRun(f.db, f.intent)?.phase).toBe("deployed");
    expect(verifies).toEqual(["T9 --dry-run", "T9 --dedup deploy-verify:m9"]);
    expect(f.db.query("SELECT count(*) AS n FROM scheduler_deploys").get()).toEqual({ n: 1 });
  } finally {
    holder.handle.release(); f.close(); rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.deferred.json`, { force: true }); rmSync(`${dir}.machine-events.json`, { force: true });
  }
});

test("[验收线 1] a crash during deferred resubmission cannot rerun a new attempt whose started marker exists", async () => {
  const { deferredDeployTick, deployJobDir } = await import("../src/lib/scheduler-deploy-lock-jobs.js");
  const { deploymentJobs } = await import("../src/lib/scheduler-deploy-job.js");
  const { mergedCard } = await import("./deploy-test-kit.js");
  const { beginDeployRun, advanceDeployRun } = await import("../src/lib/scheduler-deploy.js");
  const f = mergedCard();
  try {
    const root = join(f.dir, "jobs"), jobs = deploymentJobs({ root });
    const claim = beginDeployRun(f.db, { actor: "scheduler" }, f.intent).run;
    const run = advanceDeployRun(f.db, { actor: "scheduler" }, { intentId: f.intent, from: "claimed", to: "running", rev: claim.rev, label: jobs.label(claim) });
    const dir = deployJobDir(run, root); mkdirSync(join(dir, "started"), { recursive: true });
    writeJsonAtomicSync(`${dir}.deferred.json`, { pending: true, firstAt: 1000, job: {} });
    const d = { now: () => 2000, assertActive() {}, jobs: { ...jobs, submit: async () => { throw new Error("must not resubmit"); } },
      manager: async () => ({ ok: true }) };
    expect(await deferredDeployTick(d, run, { label: run.label!, liveness: "dead", result: null, deadline: 0 }, root)).toBe(false);
  } finally { f.close(); }
});


test("[验收线 2] deadline SIGTERM remains failed even with a waiting PM", async () => {
  const f = fixture(); f.job.createdAt = Date.now() - f.job.timeoutMs - 60_000;
  const lock = await schedulerMachineLock(f.job, f.request, { path: f.path, enabled: true, waiting: () => ["deploy-full"] });
  try { expect(lock.term()).toBeNull(); } finally { lock.release(); }
});

test("[验收线 3] observe never calls the machine lock port, notes what on would do, and keeps the deploy running", async () => {
  const { machineLockMode } = await import("../src/lib/scheduler-deploy-lock.js");
  const f = fixture(), events = () => JSON.parse(readFileSync(`${f.root}.machine-events.json`, "utf8")) as Record<string, unknown>[];
  const port = async () => { throw new Error("observe must not take the lock"); };
  const idle = await schedulerMachineLock(f.job, f.request, { path: f.path, mode: "observe", acquireMachine: port, waiting: () => [] });
  expect(idle.blocked).toBeNull(); expect(idle.term()).toBeNull(); idle.release();
  expect(events()).toMatchObject([{ status: "observed", would: "acquire", label: "scheduler-deploy" }]);
  const holder = await acquireDeployLock({ path: f.path, label: "deploy-full", waitMs: 0 });
  if (holder.kind !== "acquired") throw new Error("lock missing");
  try {
    const busy = await schedulerMachineLock(f.job, f.request, { path: f.path, mode: "observe", acquireMachine: port, waiting: () => [] });
    expect(busy.blocked).toBeNull(); expect(busy.term()).toBeNull(); busy.release();
  } finally { holder.handle.release(); }
  expect(events().slice(1)).toMatchObject([{ status: "observed", would: "defer", label: "deploy-full" }, { status: "observed", would: "defer", label: "deploy-full" }]);
  expect(readDeployLock(f.path).status).toBe("missing");
  const path = join(f.root, "policy.json");
  writeJsonAtomicSync(path, { projects: { p: { keys: { deployMachineLock: "observe" } } } });
  expect(machineLockMode("p", path)).toBe("observe");
  expect(machineLockMode("p", join(f.root, "none.json"))).toBe("on");
});
