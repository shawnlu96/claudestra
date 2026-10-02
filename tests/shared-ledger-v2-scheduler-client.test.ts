import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V2_COMMAND_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { fail, parseCommand, v2ObjectDigest, type V2Receipt } from "../src/lib/shared-ledger-contract-v2.js";
import { parseSchedulerCentralContext, type SchedulerCentralCommand, type SchedulerCentralRuntime } from "../src/lib/scheduler-central-context.js";
import { checkSchedulerCentral } from "../src/lib/scheduler-central-gate.js";
import { SchedulerCentralJournal } from "../src/lib/scheduler-central-journal.js";
import { executeSchedulerCentral } from "../src/lib/scheduler-central.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const command = V2_COMMAND_FIXTURES.find(f => f.type === "authorization.check")!.valid;
  if (command.type !== "authorization.check") throw Error("fixture");
  const bind = command.payload.bind;
  const context = parseSchedulerCentralContext({ teamId: command.teamId, projectId: command.projectId,
    serviceGeneration: command.serviceGeneration, epoch: command.epoch, bootId: command.bootId,
    homeInstanceId: "local", taskId: "task", intentId: "intent", operationId: "operation", taskRev: 1, specRev: 1, workflowRev: 1,
    head: bind.head, action: "merge", authorizationAskId: "ask", authorizationBind: bind, authorizationDigest: v2ObjectDigest(bind) });
  const root = mkdtempSync(join(tmpdir(), "central-scheduler-"));
  roots.push(root);
  const calls: SchedulerCentralCommand[] = [];
  const state = { held: true, epoch: 1, bootId: context.bootId, generation: 1, authorized: true, status: "submitted",
    leaseValid: true, online: true, loseReport: false, resourcesHeld: true };
  const runtime: SchedulerCentralRuntime = { instanceId: "local", lock: { held: () => state.held }, client: {
    async command(c) {
      parseCommand(c);
      calls.push(c);
      if (!state.online) throw Error("offline");
      if (c.serviceGeneration !== state.generation) fail("stale_generation");
      if (c.epoch !== state.epoch || c.bootId !== state.bootId) fail("stale_epoch");
      if (c.type !== "operation.result") {
        if (!state.leaseValid) fail("lease_expired");
        if (!state.authorized) fail("authorization_expired");
        if (c.type === "intent.check" && state.status !== "submitted") fail("unknown_operation");
      } else {
        if (state.loseReport) throw Error("response lost");
        state.resourcesHeld = c.payload.result.state === "unknown";
      }
      return receipt(c);
    },
  } };
  return { context, root, journal: new SchedulerCentralJournal(root), runtime, calls, state };
}
function receipt(c: SchedulerCentralCommand): V2Receipt {
  return { teamId: c.teamId, projectId: c.projectId, schemaVersion: 2, serviceGeneration: c.serviceGeneration,
    requestId: c.requestId, personId: "person", instanceId: "local", commandDigest: v2ObjectDigest(c), command: c.type,
    serverSeq: 1, committedAt: 2000, result: { entityId: "intent", rev: 1, specRev: 1, version: null, epoch: c.epoch,
      operationId: c.type === "intent.check" ? c.payload.operationId : c.type === "operation.result" ? c.payload.result.operationId : null } };
}
const success = async () => ({ state: "succeeded" as const, head: "b".repeat(40), summary: "Approved summary", artifactIds: [] });

describe("central scheduler effect gate", () => {
  test("fresh online checks precede every effect and result carries all fences", async () => {
    const f = fixture();
    let ran = 0;
    const result = await executeSchedulerCentral(f.context, f.runtime, f.journal, async () => {
      expect(f.calls.map(c => c.type)).toEqual(["authorization.check", "intent.check"]);
      ran++;
      return success();
    }, () => 2000);
    expect(result.state).toBe("succeeded");
    expect(result.result).toMatchObject({ epoch: 1, bootId: f.context.bootId, serviceGeneration: 1, approvalAskId: "ask" });
    expect(result.resourceHeld).toBe(false);
    expect(ran).toBe(1);
    expect(new Set(f.calls.map(c => c.requestId)).size).toBe(f.calls.length);
    expect((await executeSchedulerCentral(f.context, f.runtime, new SchedulerCentralJournal(f.root), async () => {
      ran++; return success();
    })).replayed).toBe(true);
    expect(ran).toBe(1);
  });
  for (const [field, value] of [
    ["epoch", 2], ["bootId", "next-boot"], ["generation", 2], ["leaseValid", false],
    ["authorized", false], ["online", false], ["held", false], ["status", "cancelled"], ["status", "unknown"], ["status", "done"],
  ] as const) {
    test(`${field}=${value} refuses the side effect`, async () => {
      const f = fixture();
      Object.assign(f.state, { [field]: value });
      let ran = false;
      const result = await executeSchedulerCentral(f.context, f.runtime, f.journal, async () => { ran = true; return success(); });
      expect(result.state).toBe("blocked");
      expect(ran).toBe(false);
      expect(f.journal.read(f.context)).toBeNull();
      expect(f.state.resourcesHeld).toBe(true);
    });
  }
  for (const action of ["dispatch", "review", "merge", "deploy", "release"] as const) {
    test(`${action} requires an online owner authorization`, async () => {
      const f = fixture();
      const bind = { ...f.context.authorizationBind, actions: [action === "dispatch" || action === "review" ? "workflow.auto" as const : action] };
      const c = parseSchedulerCentralContext({ ...f.context, action, authorizationBind: bind, authorizationDigest: v2ObjectDigest(bind) });
      f.state.authorized = false;
      const result = await executeSchedulerCentral(c, f.runtime, f.journal, success);
      expect(result.state).toBe("blocked");
      expect(f.calls[0]!.type).toBe("authorization.check");
    });
  }
  test("owner revocation between authorization and intent checks cannot run", async () => {
    const f = fixture(), original = f.runtime.client.command;
    f.runtime.client.command = async c => { const r = await original(c); f.state.authorized = false; return r; };
    expect((await executeSchedulerCentral(f.context, f.runtime, f.journal, success)).state).toBe("blocked");
    expect(f.calls.map(c => c.type)).toEqual(["authorization.check", "intent.check"]);
  });
  test("cannot execute a peer's job or degrade to an absent local lock", async () => {
    const f = fixture();
    f.runtime.instanceId = "peer-a";
    expect((await executeSchedulerCentral(f.context, f.runtime, f.journal, success)).reason).toBe("wrong_home");
    expect(f.calls).toHaveLength(0);
  });
  test("local lock is rechecked after the awaited central check", async () => {
    const f = fixture(), original = f.runtime.client.command;
    f.runtime.client.command = async c => { const r = await original(c); if (c.type === "intent.check") f.state.held = false; return r; };
    expect((await executeSchedulerCentral(f.context, f.runtime, f.journal, success)).state).toBe("blocked");
  });
  test("malformed, stale and unrelated receipts never authorize an effect", async () => {
    const f = fixture();
    for (const change of [
      { requestId: "old-request" }, { teamId: "other" }, { projectId: "other" }, { instanceId: "peer-a" },
      { serviceGeneration: 2 }, { commandDigest: "0".repeat(64) }, { result: { ...receipt(f.calls[0] ?? {
        ...f.context, requestId: "unused", type: "operation.result", payload: { result: {} as never },
      }).result, epoch: 2 } },
    ]) {
      f.runtime.client.command = async c => ({ ...receipt(c), ...change });
      expect((await executeSchedulerCentral(f.context, f.runtime, f.journal, success)).state).toBe("blocked");
    }
  });
  test("check request IDs cannot reuse cached permission", async () => {
    const f = fixture();
    await checkSchedulerCentral(f.context, f.runtime);
    await checkSchedulerCentral(f.context, f.runtime);
    expect(new Set(f.calls.map(c => c.requestId)).size).toBe(4);
  });
});

describe("unknown outbox and at-most-once local execution", () => {
  test("a thrown action is unknown, holds resources and is never retried after restart", async () => {
    const f = fixture();
    let ran = 0;
    const effect = async () => { ran++; throw Error("possibly performed"); };
    const result = await executeSchedulerCentral(f.context, f.runtime, f.journal, effect);
    expect(result.state).toBe("unknown");
    expect(result.resourceHeld).toBe(true);
    expect(f.state.resourcesHeld).toBe(true);
    await executeSchedulerCentral(f.context, f.runtime, new SchedulerCentralJournal(f.root), effect);
    expect(ran).toBe(1);
  });
  test("a lost result receipt retains the candidate in outbox without reexecuting", async () => {
    const f = fixture();
    f.state.loseReport = true;
    const first = await executeSchedulerCentral(f.context, f.runtime, f.journal, success);
    expect(first).toMatchObject({ state: "unknown", reported: false, resourceHeld: true });
    expect(f.journal.read(f.context)).toMatchObject({ state: "unknown", result: { state: "succeeded", epoch: 1 } });
    const count = f.calls.length;
    f.state.loseReport = false;
    expect((await executeSchedulerCentral(f.context, f.runtime, f.journal, success)).state).toBe("unknown");
    expect(f.calls).toHaveLength(count);
  });
  test("lost epoch during effect prevents confirmed success and keeps old fence", async () => {
    const f = fixture();
    const outcome = await executeSchedulerCentral(f.context, f.runtime, f.journal, async () => { f.state.epoch++; return success(); });
    expect(outcome).toMatchObject({ state: "unknown", resourceHeld: true, reported: false, result: { epoch: 1, state: "unknown" } });
  });
  test("started journal after a crash blocks action even with a renewed lease", async () => {
    const f = fixture();
    f.journal.begin(f.context);
    expect((await executeSchedulerCentral(f.context, f.runtime, new SchedulerCentralJournal(f.root), success)).state).toBe("unknown");
    expect(f.calls).toHaveLength(0);
    await expect(executeSchedulerCentral({ ...f.context, epoch: 2 }, f.runtime, f.journal, success)).rejects.toThrow("dedup_mismatch");
  });
  test("concurrent callers only execute once", async () => {
    const f = fixture();
    let ran = 0;
    const effect = async () => { ran++; return success(); };
    await Promise.all([executeSchedulerCentral(f.context, f.runtime, f.journal, effect), executeSchedulerCentral(f.context, f.runtime, f.journal, effect)]);
    expect(ran).toBe(1);
  });
  test("corrupt outbox refuses without overwriting evidence", async () => {
    const f = fixture();
    f.journal.begin(f.context);
    const path = join(f.root, v2ObjectDigest([f.context.teamId, f.context.projectId, f.context.taskId, f.context.intentId, f.context.operationId]), "outbox.json");
    writeFileSync(path, "broken");
    await expect(executeSchedulerCentral(f.context, f.runtime, f.journal, success)).rejects.toThrow("unknown_operation");
    expect(f.calls).toHaveLength(0);
  });
});

import { readFileSync } from "node:fs";
import { schedulerCentralDeployment, schedulerCentralDeploymentDigest, readSchedulerCentralDeployment, schedulerCentralStepOperationId,
  schedulerCentralStepRunner } from "../src/lib/scheduler-central-deploy.js";
import { runSchedulerCentralDeployJob, type SchedulerCentralWorkerDeps } from "../src/lib/scheduler-central-worker.js";
import { DEPLOY_LABEL_PREFIX } from "../src/lib/scheduler-deploy.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { reportSchedulerCentral, schedulerCentralResult } from "../src/lib/scheduler-central-gate.js";

function deployFixture() {
  const f = fixture();
  const base = { intentId: f.context.intentId, taskId: f.context.taskId, mergeSha: f.context.head!, prRef: "team/repository#1",
    label: `${DEPLOY_LABEL_PREFIX}${"a".repeat(32)}`, repoDir: f.root, relayArgv: null, restartLabels: ["local-daemon"],
    timeoutMs: 60000, createdAt: 2000, env: {} };
  const bind = { ...f.context.authorizationBind, actions: ["deploy" as const], actionDigest: schedulerCentralDeploymentDigest(base) };
  f.context = parseSchedulerCentralContext({ ...f.context, action: "deploy", authorizationBind: bind, authorizationDigest: v2ObjectDigest(bind) });
  const job = { ...base, ...schedulerCentralDeployment(f.context, "center") };
  const requestPath = join(f.root, "request.json");
  writeFileSync(requestPath, JSON.stringify(job));
  return { ...f, job, requestPath };
}
const boundedSuccess = { code: 0, stdout: "", stderr: "", timedOut: false };
function deployOutput(argv: string[]) {
  const stdout = argv.includes("--abbrev-ref") ? "main" : argv.includes("rev-parse") ? "b".repeat(40) : "";
  return { ...boundedSuccess, stdout };
}

describe("independent central deployment adapter", () => {
  test("serialized request preserves scope, authorization and fences; invalid context fails closed", () => {
    const f = deployFixture();
    const parsed = readSchedulerCentralDeployment(f.requestPath);
    expect(parsed.central.context).toEqual(f.context);
    for (const patch of [{ epoch: undefined }, { bootId: undefined }, { authorizationAskId: undefined }, { head: "c".repeat(40) }]) {
      writeFileSync(f.requestPath, JSON.stringify({ ...f.job, central: { ...f.job.central, context: { ...f.context, ...patch } } }));
      expect(() => readSchedulerCentralDeployment(f.requestPath)).toThrow();
    }
    expect(() => schedulerCentralDeployment({ ...f.context, action: "merge" }, "center")).toThrow();
  });
  test("steps use deterministic bounded IDs with no path exposure", () => {
    const f = deployFixture(), c = { ...f.context, operationId: "o".repeat(128) };
    const id = schedulerCentralStepOperationId(c, "web-release");
    expect(id).toBe(schedulerCentralStepOperationId(JSON.parse(JSON.stringify(c)), "web-release"));
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).not.toBe(schedulerCentralStepOperationId(c, "restart"));
    expect(id).not.toBe(schedulerCentralStepOperationId({ ...c, operationId: "different" }, "web-release"));
  });
  test("lease lost in step two makes it unknown and never permits step three", async () => {
    const f = deployFixture();
    let calls = 0;
    const outcome = await executeSchedulerCentral(f.context, f.runtime, f.journal, async entry => {
      const step = schedulerCentralStepRunner(f.context, f.runtime, f.journal, entry, async () => {
        calls++;
        if (calls === 2) f.state.epoch++;
        return boundedSuccess;
      });
      await step("one", ["fake"], { timeoutMs: 1000 });
      expect(f.state.resourcesHeld).toBe(true);
      expect(f.calls.filter(c => c.type === "operation.result")).toHaveLength(0);
      await expect(step("two", ["fake"], { timeoutMs: 1000 })).rejects.toThrow("stale_epoch");
      await expect(step("three", ["fake"], { timeoutMs: 1000 })).rejects.toThrow("unknown_operation");
      throw Error("step unknown");
    });
    expect(outcome.state).toBe("unknown");
    expect(calls).toBe(2);
    expect(f.journal.read(f.context)!.steps.map(s => s.state)).toEqual(["succeeded", "unknown"]);
    expect(f.calls.filter(c => c.type === "intent.check").every(c => c.payload.operationId === f.context.operationId)).toBe(true);
  });
  for (const fault of ["offline", "revoked", "timeout", "local-lock"] as const) {
    test(`${fault} at step two stops the job and leaves an unknown outbox`, async () => {
      const f = deployFixture();
      let ran = 0, opened = 0, released = 0;
      const result = await runSchedulerCentralDeployJob(f.requestPath, {
        openClient: async id => { expect(id).toBe("center"); opened++; return f.runtime; },
        acquire: async () => ({ held: () => f.state.held, path: join(f.root, "maintenance"), token: "local", release: () => { released++; } }),
        run: async argv => {
          ran++;
          if (ran === 2) {
            if (fault === "offline") f.state.online = false;
            if (fault === "revoked") f.state.authorized = false;
            if (fault === "local-lock") f.state.held = false;
            if (fault === "timeout") return { ...boundedSuccess, code: null, timedOut: true };
          }
          return deployOutput(argv);
        }, now: () => 2000,
      });
      expect(result.state).toBe("unknown");
      expect(ran).toBe(2);
      expect(opened).toBe(1);
      expect(released).toBe(1);
      const persisted = JSON.parse(readFileSync(join(f.root, "result.json"), "utf8"));
      expect(persisted.central.context).toEqual(f.context);
      expect(persisted.resourceHeld).toBe(true);
      expect(persisted.result.epoch).toBe(1);
    });
  }
  test("the existing deployment command chain runs behind the gate with one parent result", async () => {
    const f = deployFixture();
    const commands: string[][] = [];
    const result = await runSchedulerCentralDeployJob(f.requestPath, {
      openClient: async () => f.runtime,
      acquire: async () => ({ held: () => true, path: join(f.root, "lock"), token: "local", release() {} }),
      run: async argv => { commands.push(argv); return deployOutput(argv); }, now: () => 2000,
    });
    expect(result.state).toBe("succeeded");
    expect(commands.length).toBeGreaterThan(10);
    const reports = f.calls.filter(c => c.type === "operation.result");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload.result.operationId).toBe(f.context.operationId);
    expect(JSON.stringify(reports)).not.toContain(f.root);
    expect(JSON.stringify(reports)).not.toContain("local-daemon");
    expect(f.calls.filter(c => c.type === "intent.check").length).toBe(commands.length * 2 + 2);
    const saved = new SchedulerCentralJournal(join(f.root, "central-outbox")).read(f.context)!;
    expect(new Set(saved.steps.map(s => s.operationId)).size).toBe(commands.length);
  });
  test("worker refuses the job when the existing maintenance lock cannot be acquired", async () => {
    const f = deployFixture();
    const deps: SchedulerCentralWorkerDeps = {
      openClient: async () => f.runtime, acquire: async () => null, run: async () => { throw Error("must not run"); },
    };
    const result = await runSchedulerCentralDeployJob(f.requestPath, deps);
    expect(result.reason).toBe("local_lock_unavailable");
    expect(f.calls).toHaveLength(0);
  });
  test("replayed step cannot be executed even when center is still submitted", async () => {
    const f = deployFixture(), entry = f.journal.begin(f.context)!;
    let ran = 0;
    const step = schedulerCentralStepRunner(f.context, f.runtime, f.journal, entry, async () => { ran++; return boundedSuccess; });
    await step("one", ["fake"], { timeoutMs: 1 });
    await expect(step("one", ["fake"], { timeoutMs: 1 })).rejects.toThrow("unknown_operation");
    expect(ran).toBe(1);
  });
  test("a fresh child process reconstructs its own client, checks steps, and never reruns the job", async () => {
    const f = deployFixture();
    const moduleUrl = new URL("../src/lib/scheduler-central-worker.ts", import.meta.url).href;
    const contractUrl = new URL("../src/lib/shared-ledger-contract-v2.ts", import.meta.url).href;
    const script = join(f.root, "isolated-worker.ts");
    writeFileSync(script, `
      import { runSchedulerCentralDeployJob } from ${JSON.stringify(moduleUrl)};
      import { v2ObjectDigest, fail } from ${JSON.stringify(contractUrl)};
      let epoch = 1, effects = 0, opens = 0, checks = 0;
      const outcome = await runSchedulerCentralDeployJob(process.argv[2], {
        openClient: async () => { opens++; return { instanceId: "local", client: { command: async c => {
          checks++;
          if (c.epoch !== epoch) fail("stale_epoch");
          return { teamId: c.teamId, projectId: c.projectId, schemaVersion: 2, serviceGeneration: c.serviceGeneration,
            requestId: c.requestId, personId: "person", instanceId: "local", commandDigest: v2ObjectDigest(c), command: c.type,
            serverSeq: checks, committedAt: 2000, result: { entityId: "intent", rev: 1, specRev: 1, version: null,
              epoch, operationId: c.type === "intent.check" ? c.payload.operationId : null } };
        } } }; },
        acquire: async () => ({ held: () => true, path: "local-lock", token: "local", release() {} }),
        run: async argv => { effects++; if (effects === 2) epoch++; return { code: 0,
          stdout: argv.includes("--abbrev-ref") ? "main" : "", stderr: "", timedOut: false }; }, now: () => 2000,
      });
      console.log(JSON.stringify({ outcome, effects, opens, checks }));
    `);
    const run = async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", script, f.requestPath], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    };
    expect(await run()).toMatchObject({ effects: 2, opens: 1, outcome: { state: "unknown", resourceHeld: true } });
    expect(await run()).toMatchObject({ effects: 0, opens: 1, checks: 0, outcome: { state: "unknown", replayed: true } });
  });
});

test("real same-machine file lock is still required and retained by its caller", async () => {
  const f = fixture(), lock = await acquireLock(join(f.root, "lock"), 0);
  expect(lock).not.toBeNull();
  try {
    f.runtime.lock = lock!;
    expect((await executeSchedulerCentral(f.context, f.runtime, f.journal, success)).state).toBe("succeeded");
    expect(lock!.held()).toBe(true);
    expect(await acquireLock(join(f.root, "lock"), 0)).toBeNull();
  } finally { lock!.release(); }
});

test("result reporting cannot substitute a different epoch, task, intent or operation", async () => {
  const f = fixture();
  const valid = schedulerCentralResult(f.context, await success(), 2000);
  for (const patch of [{ epoch: 2 }, { taskId: "other" }, { intentId: "other" }, { operationId: "other" }, { approvalAskId: "other" }]) {
    await expect(reportSchedulerCentral(f.context, f.runtime, { ...valid, ...patch })).rejects.toThrow("invalid_field");
  }
  expect(f.calls).toHaveLength(0);
});

test("deployment authorization binds the actual local plan without uploading its arguments", () => {
  const f = deployFixture();
  for (const patch of [{ repoDir: join(f.root, "other") }, { relayArgv: ["unexpected-command"] },
    { restartLabels: ["other-daemon"] }, { timeoutMs: 120000 }, { env: { EXTRA: "changed" } }]) {
    writeFileSync(f.requestPath, JSON.stringify({ ...f.job, ...patch }));
    expect(() => readSchedulerCentralDeployment(f.requestPath)).toThrow("invalid_field");
  }
});

test("a caller swallowing an unknown step cannot release the parent's resources", async () => {
  const f = deployFixture();
  const result = await executeSchedulerCentral(f.context, f.runtime, f.journal, async entry => {
    const run = schedulerCentralStepRunner(f.context, f.runtime, f.journal, entry, async () => ({ ...boundedSuccess, timedOut: true }));
    await expect(run("one", ["fake"], { timeoutMs: 1 })).rejects.toThrow("unknown_operation");
    return success();
  });
  expect(result.state).toBe("unknown");
  expect(f.state.resourcesHeld).toBe(true);
});

test("the local lock must still be held after the durable step checkpoint", async () => {
  const f = deployFixture(), entry = f.journal.begin(f.context)!;
  const write = f.journal.write.bind(f.journal);
  f.journal.write = item => { write(item); f.state.held = false; };
  let calls = 0;
  const run = schedulerCentralStepRunner(f.context, f.runtime, f.journal, entry, async () => { calls++; return boundedSuccess; });
  await expect(run("one", ["fake"], { timeoutMs: 1 })).rejects.toThrow("stale_epoch");
  expect(calls).toBe(0);
});

test("an existing independent job start marker is never bypassed", async () => {
  const f = deployFixture();
  mkdirSync(join(f.root, "started"));
  let ran = false;
  const result = await runSchedulerCentralDeployJob(f.requestPath, {
    openClient: async () => f.runtime,
    acquire: async () => ({ held: () => true, path: join(f.root, "lock"), token: "local", release() {} }),
    run: async () => { ran = true; return boundedSuccess; }, now: () => 2000,
  });
  expect(result.state).toBe("unknown");
  expect(result.resourceHeld).toBe(true);
  expect(ran).toBe(false);
});
