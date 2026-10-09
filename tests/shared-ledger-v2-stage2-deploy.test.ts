import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V2_COMMAND_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { fail, parseCommand, v2ObjectDigest, type V2Receipt } from "../src/lib/shared-ledger-contract-v2.js";
import { parseSchedulerCentralContext, type SchedulerCentralCommand, type SchedulerCentralRuntime } from "../src/lib/scheduler-central-context.js";
import { readSchedulerCentralDeployment, schedulerCentralDeployment, schedulerCentralDeploymentDigest } from "../src/lib/scheduler-central-deploy.js";
import { deploymentJobs, type DeployJob } from "../src/lib/scheduler-deploy-job.js";
import { DEPLOY_LABEL_PREFIX, type DeployRun } from "../src/lib/scheduler-deploy.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import {
  centralDeployDeps, runDeployJobV2, schedulerV2DeploySubmit, V2DeployHeld,
  type DeployV2Decision, type DeployV2Route, type DeploySubmitV2Port,
} from "../src/lib/scheduler-v2-deploy.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = mkdtempSync(join(tmpdir(), "s2m-deploy-")); roots.push(r); return r; };

type Switch = "off" | "observe" | "on";
type Card = { execution: boolean; migrating: boolean };
/** Fake of S2D's frozen route rule (§2.2), over a synthetic mode table; S2M only consumes it. */
function fakeRoute(cards: Record<string, Card>, mode: Switch, portNull = false) {
  return (taskId: string): DeployV2Route => {
    const c = cards[taskId]!;
    if (c.migrating) return "skip";
    if (!c.execution) return "local";
    return mode === "on" && !portNull ? "central" : "skip";
  };
}

const bindFixture = (() => {
  const command = V2_COMMAND_FIXTURES.find(f => f.type === "authorization.check")!.valid;
  if (command.type !== "authorization.check") throw Error("fixture");
  return command;
})();
function contextFor(job: Pick<DeployJob, "taskId" | "intentId" | "mergeSha"> & Parameters<typeof schedulerCentralDeploymentDigest>[0]) {
  const c = bindFixture;
  const bind = { ...c.payload.bind, homeInstanceId: "local", taskId: job.taskId, taskRev: 1, specRev: 1, workflowRev: 1,
    head: job.mergeSha, actions: ["deploy" as const], actionDigest: schedulerCentralDeploymentDigest(job) };
  return parseSchedulerCentralContext({ teamId: c.teamId, projectId: c.projectId, serviceGeneration: c.serviceGeneration, epoch: c.epoch,
    bootId: c.bootId, homeInstanceId: "local", taskId: job.taskId, intentId: job.intentId, operationId: "operation", taskRev: 1,
    specRev: 1, workflowRev: 1, head: job.mergeSha, action: "deploy", authorizationAskId: "ask", authorizationBind: bind,
    authorizationDigest: v2ObjectDigest(bind) });
}

/** Fake center: records every command; `staleAfterRuns` makes intent.check throw stale_epoch once that many argv ran. */
function fakeCenter() {
  const calls: SchedulerCentralCommand[] = [];
  const state = { ran: 0, staleAfterRuns: Infinity, opened: 0 };
  const runtime: SchedulerCentralRuntime = { instanceId: "local", lock: { held: () => true }, client: {
    async command(c) {
      parseCommand(c);
      calls.push(c);
      if (c.type === "intent.check" && state.ran >= state.staleAfterRuns) fail("stale_epoch");
      return { teamId: c.teamId, projectId: c.projectId, schemaVersion: 2, serviceGeneration: c.serviceGeneration, requestId: c.requestId,
        personId: "person", instanceId: "local", commandDigest: v2ObjectDigest(c), command: c.type, serverSeq: 1, committedAt: 2000,
        result: { entityId: "intent", rev: 1, specRev: 1, version: null, epoch: c.epoch,
          operationId: c.type === "intent.check" ? c.payload.operationId : c.type === "operation.result" ? c.payload.result.operationId : null } } satisfies V2Receipt;
    },
  } };
  const openClient = async () => { state.opened++; return runtime; };
  return { calls, state, runtime, openClient };
}

const SHA = "b".repeat(40);
const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
const deployOutput = (argv: string[]) => ({ ...ok, stdout: argv.includes("--abbrev-ref") ? "main" : argv.includes("rev-parse") ? SHA : "" });
const lock = (root: string) => async () => ({ held: () => true, path: join(root, "maintenance"), token: "t", release() {} });

/** A request.json written directly (worker side), optionally with the X8 `central` field. */
function request(root: string, central: boolean, taskId = "T1") {
  const job: DeployJob = { intentId: `i-${taskId}`, taskId, mergeSha: SHA, prRef: "team/repo#1", label: `${DEPLOY_LABEL_PREFIX}${"a".repeat(32)}`,
    repoDir: root, relayArgv: null, restartLabels: ["x.fake.one"], timeoutMs: 60_000, createdAt: 2000, env: {} };
  const path = join(root, "request.json");
  writeFileSync(path, JSON.stringify(central ? { ...job, ...schedulerCentralDeployment(contextFor(job), "center") } : job));
  return { job, path };
}
function worker(root: string) {
  const argv: string[][] = [], center = fakeCenter();
  const run: typeof runBounded = async a => { argv.push(a); center.state.ran++; return deployOutput(a); };
  return { argv, center, local: { run, acquire: lock(root), now: () => 2000, uid: 501 } };
}
const result = (root: string) => JSON.parse(readFileSync(join(root, "result.json"), "utf8"));

describe("S2M worker: central jobs go through X8", () => {
  test("acceptance 1: intent.check throws stale_epoch after step 1 → step 2 never runs, unknown, resourceHeld, result.json unknown", async () => {
    const root = tmp(), { path } = request(root, true), w = worker(root);
    w.center.state.staleAfterRuns = 1;
    const out = await runDeployJobV2(path, centralDeployDeps(w.center.openClient, () => "central", w.local));
    expect(w.argv).toHaveLength(1);
    expect(out.path).toBe("central");
    if (out.path !== "central") throw Error("path");
    expect(out.outcome.state).toBe("unknown");
    expect(out.outcome.resourceHeld).toBe(true);
    const saved = result(root);
    expect(saved.state).toBe("unknown");
    expect(saved.resourceHeld).toBe(true);
    expect(saved.ok).toBe(false);
    expect(w.center.calls.filter(c => c.type === "intent.check").at(-1)!.payload).toMatchObject({ operationId: "operation" });
  });

  test("acceptance 2: central job without deps.central → blocked, 0 argv, no lock, no client", async () => {
    const root = tmp(), { path } = request(root, true), w = worker(root);
    let acquired = 0;
    const out = await runDeployJobV2(path, centralDeployDeps(null, () => "central", { ...w.local, acquire: async () => { acquired++; return null; } }));
    expect(out).toEqual({ path: "blocked", central: true, reason: "unavailable" });
    expect(w.argv).toHaveLength(0);
    expect(acquired).toBe(0);
    expect(w.center.state.opened).toBe(0);
    expect(result(root)).toMatchObject({ ok: false, state: "blocked", resourceHeld: true, intentId: "i-T1", mergeSha: SHA });
    // The blocked request is claimed: a relaunch, even with a client, runs nothing (X8 sees `started` → unknown).
    const again = await runDeployJobV2(path, centralDeployDeps(w.center.openClient, () => "central", w.local));
    expect(again.path === "central" && again.outcome.state).toBe("unknown");
    expect(w.argv).toHaveLength(0);
    expect(await runDeployJobV2(path, centralDeployDeps(null, () => "central", w.local)))
      .toEqual({ path: "blocked", central: true, reason: "already_started" });
  });

  test("acceptance 2: a non-central job runs the stage-1 worker unchanged, with zero center requests", async () => {
    const root = tmp(), { path } = request(root, false), w = worker(root);
    const out = await runDeployJobV2(path, centralDeployDeps(w.center.openClient, () => "local", w.local));
    expect(out.path).toBe("local");
    if (out.path !== "local") throw Error("path");
    expect(out.outcome?.ok).toBe(true);
    expect(w.argv.length).toBeGreaterThan(10);
    expect(w.center.state.opened).toBe(0);
    expect(w.center.calls).toHaveLength(0);
    expect(result(root)).toMatchObject({ ok: true, intentId: "i-T1" });
  });

  test("a central job whose card is now skip (migrating) is blocked before the client is opened", async () => {
    const root = tmp(), { path } = request(root, true), w = worker(root);
    const out = await runDeployJobV2(path, centralDeployDeps(w.center.openClient, () => "skip", w.local));
    expect(out).toEqual({ path: "blocked", central: true, reason: "route_skip" });
    expect(w.argv).toHaveLength(0);
    expect(w.center.state.opened).toBe(0);
  });

  test("a stage-1 job left for a card that is now execution (skip / central) runs nothing", async () => {
    for (const route of ["skip", "central"] as const) {
      const root = tmp(), { path } = request(root, false), w = worker(root);
      expect(await runDeployJobV2(path, centralDeployDeps(w.center.openClient, () => route, w.local)))
        .toEqual({ path: "blocked", central: false, reason: `route_${route}` });
      expect(w.argv).toHaveLength(0);
      expect(w.center.calls).toHaveLength(0);
    }
  });

  test("without a route (stage 1 wiring) a central job still needs deps.central and otherwise runs X8", async () => {
    const root = tmp(), { path } = request(root, true), w = worker(root);
    const out = await runDeployJobV2(path, centralDeployDeps(w.center.openClient, null, w.local));
    expect(out.path === "central" && out.outcome.state).toBe("succeeded");
    expect(w.center.calls.filter(c => c.type === "operation.result")).toHaveLength(1);
  });
});

/** Submit side over a fake launchctl and a synthetic mode table. */
function submitter(cards: Record<string, Card>, mode: Switch, opts: { portNull?: boolean; deployment?: boolean } = {}) {
  const root = tmp(), commands: string[][] = [], decisions: DeployV2Decision[] = [], center = fakeCenter();
  let deploymentCalls = 0;
  const command: typeof runBounded = async a => { commands.push(a); return a[1] === "list" ? { ...ok, code: 113, stderr: "Could not find service" } : ok; };
  const port: DeploySubmitV2Port = { route: fakeRoute(cards, mode, opts.portNull), record: d => decisions.push(d),
    ...(opts.deployment === false ? {} : { async deployment(_run: DeployRun, job: DeployJob) { deploymentCalls++; return { context: contextFor(job), connectionId: "center" }; } }) };
  const jobs = deploymentJobs({ root: join(root, "jobs"), command, now: () => 2000, uid: 501, v2: schedulerV2DeploySubmit(port) });
  const plain = deploymentJobs({ root: join(root, "plain"), command: async a => { commands.push(a); return ok; }, now: () => 2000, uid: 501 });
  const attempt = (taskId: string, j = jobs): DeployRun => {
    const run = { intentId: `i-${taskId}`, taskId, prRef: "team/repo#1", mergeSha: SHA } as DeployRun;
    return { ...run, phase: "running", label: j.label(run) };
  };
  const files = (sub = "jobs") => existsSync(join(root, sub)) ? readdirSync(join(root, sub)) : [];
  return { root, commands, decisions, center, jobs, plain, attempt, files, deployments: () => deploymentCalls };
}
const target = { restartLabels: ["x.fake.one"], timeoutMs: 60_000 };
const CARDS: Record<string, Card> = {
  local: { execution: false, migrating: false }, exec: { execution: true, migrating: false },
  migPlan: { execution: false, migrating: true }, migExec: { execution: true, migrating: true },
};
/** Everything a submit leaves on disk and sends to launchctl, with the temp root normalized away. */
function footprint(s: ReturnType<typeof submitter>, sub = "jobs") {
  // Job directory and label derive from the temp root's path; everything else must match byte for byte.
  const norm = (x: string) => x.split(s.root).join("<root>").split(`/${sub}/`).join("/<sub>/").replace(/deploy\.[a-f0-9]{32}/g, "deploy.<h>")
    .replace(/[a-f0-9]{64}/g, "<dir>");
  const dirs = s.files(sub).map(d => {
    const dir = join(s.root, sub, d);
    return { request: JSON.parse(norm(readFileSync(join(dir, "request.json"), "utf8"))), plist: norm(readFileSync(join(dir, "job.plist"), "utf8")) };
  });
  return { dirs, commands: s.commands.map(a => a.map(norm)) };
}

describe("S2M submit: route decides whether and how the job is built", () => {
  test("route=central attaches schedulerCentralDeployment; the worker then runs it through X8", async () => {
    const s = submitter(CARDS, "on");
    await s.jobs.submit(s.attempt("exec"), s.root, target);
    const [dir] = s.files();
    const job = readSchedulerCentralDeployment(join(s.root, "jobs", dir!, "request.json"));
    expect(job.central.connectionId).toBe("center");
    expect(job.central.context.action).toBe("deploy");
    expect(s.commands.filter(a => a[1] === "bootstrap")).toHaveLength(1);
    expect(s.decisions).toEqual([{ taskId: "exec", intentId: "i-exec", route: "central", outcome: "central", reason: "central" }]);
    expect(s.center.calls).toHaveLength(0); // the submit itself never talks to the center
    const w = worker(s.root);
    const out = await runDeployJobV2(join(s.root, "jobs", dir!, "request.json"), centralDeployDeps(w.center.openClient, fakeRoute(CARDS, "on"), w.local));
    expect(out.path === "central" && out.outcome.state).toBe("succeeded");
    expect(w.center.state.opened).toBe(1);
  });

  test("a deployment that does not bind this job's plan is refused before anything is written", async () => {
    const s = submitter(CARDS, "on"), jobs = deploymentJobs({ root: join(s.root, "jobs"), command: async a => { s.commands.push(a); return ok; },
      now: () => 2000, v2: schedulerV2DeploySubmit({ route: () => "central",
        deployment: async (_r, job) => ({ context: contextFor({ ...job, timeoutMs: job.timeoutMs + 1 }), connectionId: "center" }) }) });
    await expect(jobs.submit(s.attempt("exec", jobs), s.root, target)).rejects.toThrow(V2DeployHeld);
    expect(s.files()).toEqual([]);
    expect(s.commands).toHaveLength(0);
  });

  test("an existing claim is observed, never re-routed or re-prepared", async () => {
    const s = submitter(CARDS, "on");
    const label = await s.jobs.submit(s.attempt("exec"), s.root, target);
    expect(await s.jobs.submit(s.attempt("exec"), s.root, target)).toBe(label);
    expect(s.deployments()).toBe(1);
    expect(s.commands.filter(a => a[1] === "bootstrap")).toHaveLength(1);
  });
});

describe("S2M §7.2 coexistence", () => {
  test("1 off: non-execution card is stage 1; execution card is held; center / deployment port called 0 times", async () => {
    const s = submitter(CARDS, "off");
    await s.jobs.submit(s.attempt("local"), s.root, target);
    expect(s.files()).toHaveLength(1);
    await expect(s.jobs.submit(s.attempt("exec"), s.root, target)).rejects.toMatchObject({ code: "migrating_or_skip" });
    expect(s.files()).toHaveLength(1);
    expect(s.commands.filter(a => a[1] === "bootstrap")).toHaveLength(1);
    expect(s.deployments()).toBe(0);
    expect(s.center.calls).toHaveLength(0);
    expect(s.center.state.opened).toBe(0);
  });

  test("2 observe: same synthetic cards under off and observe leave identical files / launchctl calls; the held decision is recorded", async () => {
    const off = submitter(CARDS, "off"), obs = submitter(CARDS, "observe");
    for (const s of [off, obs]) {
      await s.jobs.submit(s.attempt("local"), s.root, target);
      await expect(s.jobs.submit(s.attempt("exec"), s.root, target)).rejects.toThrow(V2DeployHeld);
    }
    expect(footprint(obs)).toEqual(footprint(off));
    expect(obs.decisions.map(d => [d.taskId, d.outcome, d.reason])).toEqual([["local", "local", "local"], ["exec", "held", "skip"]]);
    expect(obs.center.calls).toHaveLength(0);
    expect(obs.deployments()).toBe(0);
  });

  test("3 on + non-execution card: field-for-field equal to off and to the stage-1 jobs without a hook", async () => {
    const off = submitter(CARDS, "off"), on = submitter(CARDS, "on");
    for (const s of [off, on]) {
      await s.jobs.submit(s.attempt("local"), s.root, target);
      await s.plain.submit(s.attempt("local", s.plain), s.root, target);
    }
    expect(footprint(on)).toEqual(footprint(off));
    const hooked = footprint(on).dirs[0]!, plain = footprint(on, "plain").dirs[0]!;
    expect(hooked.request).toEqual(plain.request);
    expect(hooked.request.central).toBeUndefined();
    expect(on.center.calls).toHaveLength(0);
    expect(on.deployments()).toBe(0);
  });

  test("4 on + execution card + port null: unavailable is returned and recorded; no directory, no launchctl, no center", async () => {
    const s = submitter(CARDS, "on", { deployment: false });
    await expect(s.jobs.submit(s.attempt("exec"), s.root, target)).rejects.toMatchObject({ code: "unavailable" });
    expect(s.decisions.at(-1)).toMatchObject({ taskId: "exec", outcome: "held", reason: "unavailable" });
    expect(s.files()).toEqual([]);
    expect(s.commands).toHaveLength(0);
    // Worker side of a null port: a central request is blocked as unavailable.
    const root = tmp(), { path } = request(root, true), w = worker(root);
    expect(await runDeployJobV2(path, centralDeployDeps(null, fakeRoute({ T1: CARDS.exec! }, "on"), w.local)))
      .toEqual({ path: "blocked", central: true, reason: "unavailable" });
    expect(w.argv).toHaveLength(0);
    // S2D reports a null center port as route skip: also no job.
    const n = submitter(CARDS, "on", { portNull: true });
    await expect(n.jobs.submit(n.attempt("exec"), n.root, target)).rejects.toThrow(V2DeployHeld);
    expect(n.files()).toEqual([]);
    expect(n.deployments()).toBe(0);
  });

  test("5 migrating (planning and execution, switch on): 0 center requests, 0 local side effects on both sides", async () => {
    const s = submitter(CARDS, "on");
    for (const card of ["migPlan", "migExec"]) {
      await expect(s.jobs.submit(s.attempt(card), s.root, target)).rejects.toMatchObject({ code: "migrating_or_skip" });
    }
    expect(s.files()).toEqual([]);
    expect(s.commands).toHaveLength(0);
    expect(s.deployments()).toBe(0);
    for (const [card, central] of [["migPlan", false], ["migExec", true]] as const) {
      const root = tmp(), { path } = request(root, central, card), w = worker(root);
      const out = await runDeployJobV2(path, centralDeployDeps(w.center.openClient, fakeRoute(CARDS, "on"), w.local));
      expect(out).toEqual({ path: "blocked", central, reason: "route_skip" });
      expect(w.argv).toHaveLength(0);
      expect(w.center.state.opened).toBe(0);
      expect(w.center.calls).toHaveLength(0);
    }
  });

  test("5 migration while the central deployment is being prepared (central → skip): held, no jobs directory, no launchctl", async () => {
    const cards = { ...CARDS, exec: { ...CARDS.exec! } };
    const s = submitter(cards, "on"), decisions: DeployV2Decision[] = [];
    const jobs = deploymentJobs({ root: join(s.root, "jobs"), command: async a => { s.commands.push(a); return ok; }, now: () => 2000,
      v2: schedulerV2DeploySubmit({ route: fakeRoute(cards, "on"), record: d => decisions.push(d),
        async deployment(_r, job) { cards.exec.migrating = true; return { context: contextFor(job), connectionId: "center" }; } }) });
    await expect(jobs.submit(s.attempt("exec", jobs), s.root, target)).rejects.toMatchObject({ code: "migrating_or_skip" });
    expect(existsSync(join(s.root, "jobs"))).toBe(false);
    expect(s.commands).toHaveLength(0);
    expect(decisions).toEqual([{ taskId: "exec", intentId: "i-exec", route: "skip", outcome: "held", reason: "skip" }]);
  });

  test("5 the route is checked again at the write boundary, after prepare has returned", async () => {
    const s = submitter(CARDS, "on");
    let route: DeployV2Route = "central";
    const hook = schedulerV2DeploySubmit({ route: () => route,
      deployment: async (_r, job) => ({ context: contextFor(job), connectionId: "center" }) });
    const jobs = deploymentJobs({ root: join(s.root, "jobs"), command: async a => { s.commands.push(a); return ok; }, now: () => 2000,
      v2: { async prepare(run, job) { const extra = await hook.prepare(run, job); route = "skip"; return extra; }, confirm: hook.confirm } });
    await expect(jobs.submit(s.attempt("exec", jobs), s.root, target)).rejects.toMatchObject({ code: "migrating_or_skip" });
    expect(existsSync(join(s.root, "jobs"))).toBe(false);
    expect(s.commands).toHaveLength(0);
  });
});
