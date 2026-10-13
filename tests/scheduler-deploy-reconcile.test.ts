import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { appendEvent } from "../src/lib/ledger-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { ledgerAs, mergedCard, type MergedCard } from "./deploy-test-kit.js";
import { deployReconcileTick } from "../src/lib/scheduler-deploy-reconcile.js";
import { writeDeployReconcile } from "../src/lib/scheduler-deploy-reconcile-write.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { DEPLOY_RECONCILE_MAX_AGE_MS, readReconcileFacts, reconcileTaskIds } from "../src/lib/scheduler-deploy-reconcile-facts.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { acquireLock } from "../src/lib/file-lock.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { testChildEnv } from "./test-env.js";

const cards: MergedCard[] = [];
afterEach(() => { for (const c of cards.splice(0)) c.close(); });

/** Candidate shapes (DEPRECON2): "settled" = manual merge card whose intent is done; "paused" keeps m9 submitted for a
 * test that pauses the workflow itself (deployDrift non-null). A submitted auto card with drift null is not a candidate. */
function fixture(shape: "settled" | "paused" = "settled") {
  const c = mergedCard(); cards.push(c);
  if (shape === "settled") c.db.query("UPDATE scheduler_intents SET status='done' WHERE id='m9'").run();
  const repoDir = join(c.dir, "repo");
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: args[0] === "init" ? c.dir : repoDir });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "-q", repoDir); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "merged"); const merge = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "deployed"); const version = git("rev-parse", "HEAD");
  c.db.query("UPDATE scheduler_merges SET mergeSha=? WHERE intentId='m9'").run(merge);
  c.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
    SELECT 150,actor,project,target,kind,text,json_set(data,'$.mergeSha',?) FROM events WHERE json_extract(data,'$.to')='merged'`).run(merge);
  appendEvent(c.db, { actor: "owner", now: 200 }, { project: "p", target: "", kind: "deploy", data: { version, rollbackPoint: null } });
  const config = { enabled: true, autoDispatch: false, pollMs: 5000,
    projects: { p: { repoDir, requiredChecks: ["ci"], maxActiveWorkers: 2 } } };
  let mode: RecoveryMode = "on";
  const policy: RecoveryPolicyPort = () => ({ mode, manualAfterMs: null, source: "default" });
  const notices: string[] = [], logs: string[] = [], calls: string[][] = [];
  const deps = { policy, assertActive() {}, now: () => 300, log: (s: string) => { logs.push(s); },
    notifyPm: async (_project: string, s: string) => { notices.push(s); },
    manager: async (...args: string[]) => {
      calls.push(args);
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      return writeDeployReconcile(c.db, { actor: "scheduler", now: 300 }, { taskId: args[2]!, taskRev: Number(value("--rev")),
        intentId: value("--merge-intent"), mergeRev: Number(value("--merge-rev")), sourceSeq: Number(value("--source-seq")) },
      { repoDir, policy, assertActive() {} });
    } };
  return { ...c, config, deps, merge, version, git, notices, logs, calls, mode: (m: RecoveryMode) => { mode = m; } };
}

test("[验收线 1] ancestor is recorded once, reaches live, and leaves verification to the workflow", async () => {
  const f = fixture();
  const before = listEvents(f.db, { target: "T9" });
  await deployReconcileTick(f.db, f.config, f.deps);
  await deployReconcileTick(f.db, f.config, f.deps);
  const added = listEvents(f.db, { target: "T9" }).slice(before.length);
  expect(added.map((e) => e.kind)).toEqual(["deploy", "stage"]);
  expect(added[0]!.actor).toBe("scheduler");
  expect(added[0]!.data).toMatchObject({ version: f.version, rollbackPoint: null, reconciledBy: "deployReconcile" });
  expect(added[1]!.data).toMatchObject({ from: "merge", to: "live", round: 1, specRev: 1 });
  expect(getTask(f.db, "T9")?.stage).toBe("live");
  expect(listEvents(f.db, { target: "T9" }).filter((e) => e.kind === "verify")).toHaveLength(0);
  expect(f.calls).toHaveLength(1);
});

test("[验收线 1] observe changes no task/deploy/stage and emits one durable observation and one PM summary", async () => {
  const f = fixture(); f.mode("observe");
  const task = getTask(f.db, "T9");
  await deployReconcileTick(f.db, f.config, f.deps); await deployReconcileTick(f.db, f.config, f.deps);
  expect(getTask(f.db, "T9")).toEqual(task);
  const events = listEvents(f.db, { target: "T9" });
  expect(events.filter((e) => e.kind === "deploy")).toHaveLength(0);
  expect(events.filter((e) => e.data.mechanism === "deployReconcile")).toHaveLength(1);
  expect(f.notices).toHaveLength(1);
});

type Fixture = ReturnType<typeof fixture>;
const deploy = (f: Fixture, data: Record<string, unknown>, now = 201) =>
  appendEvent(f.db, { actor: "owner", now }, { project: "p", target: "", kind: "deploy", data });
const inputOf = (f: Fixture) => {
  const result = readReconcileFacts(f.db, "T9", 300);
  if ("reason" in result) throw new Error(result.reason);
  const { task, merge, source } = result.facts;
  return { taskId: task.id, taskRev: task.rev, intentId: merge.intentId, mergeRev: merge.rev, sourceSeq: source.seq };
};

const unsafe: [string, (f: Fixture) => void, string][] = [
  ["non-ancestor", (f) => {
    f.git("checkout", "-q", "--orphan", "other"); f.git("commit", "-q", "--allow-empty", "-m", "unrelated");
    deploy(f, { version: f.git("rev-parse", "HEAD") });
  }, "merge-not-ancestor"],
  ["missing merge SHA", (f) => { f.db.query("UPDATE scheduler_merges SET mergeSha=NULL").run(); }, "merge-sha-missing"],
  ["missing deployment", (f) => {
    // The append-only production table is never altered; a separate project supplies a genuine no-record fixture.
    f.db.query("UPDATE tasks SET project='q'").run(); f.db.query("UPDATE scheduler_merges SET project='q'").run();
    f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
      SELECT ts,actor,'q',target,kind,text,data FROM events WHERE kind='scheduler' AND json_extract(data,'$.to')='merged' ORDER BY seq DESC LIMIT 1`).run();
    f.config.projects = { q: f.config.projects.p! } as unknown as typeof f.config.projects;
  }, "deployment-missing"],
  ["expired deployment", (f) => { f.deps.now = () => 201 + DEPLOY_RECONCILE_MAX_AGE_MS; }, "deployment-expired"],
  ["future deployment", (f) => { deploy(f, { version: f.version }, 301); }, "deployment-expired"],
  ["latest source unreadable", (f) => { deploy(f, { version: "main" }); }, "deployment-unreadable"],
  ["commit unavailable", (f) => { deploy(f, { version: "a".repeat(40) }); }, "deployment-commit-unreadable"],
  ["rollback", (f) => { appendEvent(f.db, { actor: "owner", now: 202 }, { project: "p", target: "", kind: "rollback" }); }, "rollback-after-deployment"],
  ["deploy in flight", (f) => {
    f.db.query(`INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,createdAt,updatedAt)
      SELECT intentId,taskId,project,prRef,mergeSha,'claimed',250,250 FROM scheduler_merges`).run();
  }, "deployment-unsettled"],
  ["changed reviewed head", (f) => { f.db.query("UPDATE tasks SET headSHA=?").run("b".repeat(40)); }, "merge-head-changed"],
  ["deploy already recorded", (f) => {
    appendEvent(f.db, { actor: "owner", now: 250 }, { project: "p", target: "T9", kind: "deploy", data: { version: f.version } });
  }, "already-deployed"],
];

for (const [name, mutate, reason] of unsafe) test(`[验收线 2] ${name} writes nothing and logs once across ticks`, async () => {
  const f = fixture(); mutate(f);
  const count = listEvents(f.db, {}).length, task = getTask(f.db, "T9");
  await deployReconcileTick(f.db, f.config, f.deps); await deployReconcileTick(f.db, f.config, f.deps);
  expect(listEvents(f.db, {})).toHaveLength(count);
  expect(getTask(f.db, "T9")).toEqual(task);
  expect(f.calls).toHaveLength(0); expect(f.notices).toHaveLength(0);
  expect(f.logs).toEqual([`[deploy-reconcile] T9: ${reason}`]);
});

test("[验收线 2] reconciled records cannot replace production evidence or refresh its age", async () => {
  const f = fixture(); deploy(f, { version: "a".repeat(40), reconciledBy: "deployReconcile" }, 299);
  await deployReconcileTick(f.db, f.config, f.deps);
  expect(getTask(f.db, "T9")?.stage).toBe("live");
  expect(listEvents(f.db, { target: "T9" }).findLast((e) => e.kind === "deploy")?.data.version).toBe(f.version);
});

test("[验收线 3] off produces no reads, commands, notices or diagnostics", async () => {
  const f = fixture(); f.mode("off");
  const events = listEvents(f.db, {}), task = getTask(f.db, "T9");
  const noRead = new Proxy(f.db, { get() { throw new Error("off touched ledger"); } });
  await deployReconcileTick(noRead, f.config, f.deps);
  expect(listEvents(f.db, {})).toEqual(events); expect(getTask(f.db, "T9")).toEqual(task);
  expect([f.calls, f.logs, f.notices]).toEqual([[], [], []]);
});

test("[验收线 1] short recorded version is resolved to its unambiguous full commit", async () => {
  const f = fixture(); deploy(f, { version: f.version.slice(0, 12) });
  await deployReconcileTick(f.db, f.config, f.deps);
  expect(listEvents(f.db, { target: "T9" }).findLast((e) => e.kind === "deploy")?.data.version).toBe(f.version);
});

test("[验收线 2] git proof does not authorize a changed source, policy, or task", async () => {
  for (const change of ["source", "policy", "task", "expiry"] as const) {
    const f = fixture(), input = inputOf(f); let changed = false, now = 300;
    const command: typeof runBounded = async (argv, opts) => {
      const r = await runBounded(argv, opts);
      if (!changed) {
        changed = true;
        if (change === "source") deploy(f, { version: f.version }, 250);
        if (change === "policy") f.mode("off");
        if (change === "task") f.db.query("UPDATE tasks SET rev=rev+1").run();
        if (change === "expiry") now += DEPLOY_RECONCILE_MAX_AGE_MS;
      }
      return r;
    };
    await expect(writeDeployReconcile(f.db, { actor: "scheduler", now: 300 }, input, {
      repoDir: f.config.projects.p.repoDir, policy: f.deps.policy, assertActive() {}, command, now: () => now,
    })).rejects.toThrow();
    expect(getTask(f.db, "T9")?.stage).toBe("merge");
    expect(listEvents(f.db, { target: "T9" }).filter((e) => e.kind === "deploy")).toHaveLength(0);
  }
});

test("[验收线 1] failure during stage mutation rolls back the deploy event too", async () => {
  const f = fixture();
  f.db.query("CREATE TRIGGER refuse_live BEFORE UPDATE OF stage ON tasks WHEN NEW.stage='live' BEGIN SELECT RAISE(ABORT,'test refusal'); END").run();
  await expect(writeDeployReconcile(f.db, { actor: "scheduler", now: 300 }, inputOf(f), {
    repoDir: f.config.projects.p.repoDir, policy: f.deps.policy, assertActive() {},
  })).rejects.toThrow("test refusal");
  expect(getTask(f.db, "T9")?.stage).toBe("merge");
  expect(listEvents(f.db, { target: "T9" }).filter((e) => e.kind === "deploy")).toHaveLength(0);
});

test("[验收线 2] lease loss stops before a write and is propagated", async () => {
  const f = fixture();
  await expect(deployReconcileTick(f.db, f.config, { ...f.deps, assertActive() { throw new SchedulerStopped("lost"); } })).rejects.toThrow("lost");
  expect(f.calls).toHaveLength(0);
});

test("[验收线 2] skip card gate prevents git, ledger, notices and diagnostics", async () => {
  const f = fixture();
  await deployReconcileTick(f.db, f.config, { ...f.deps, command: async () => { throw new Error("git ran"); } },
    { skipTask: () => true, yieldNow: () => false, cursor: {} });
  expect([f.calls, f.logs, f.notices]).toEqual([[], [], []]);
});

test("[验收线 2] ordinary agent and service without lease cannot invoke the command", async () => {
  const f = fixture();
  for (const actor of ["agent-author", "scheduler"]) {
    const result = await ledgerAs(f.db, actor)("ledger", "scheduler-deploy-reconcile", "T9");
    expect(result.code).toBe("forbidden"); expect(result.error).toContain("有效租约");
  }
  expect(listEvents(f.db, { target: "T9" }).filter((e) => e.kind === "deploy")).toHaveLength(0);
});

test("[验收线 1] manual workflow and merge queue are preserved, with zero verification events", async () => {
  const f = fixture("paused"); f.db.query("UPDATE task_workflows SET mode='manual'").run();
  const workflow = f.db.query("SELECT * FROM task_workflows WHERE taskId='T9'").get();
  const intent = f.db.query("SELECT * FROM scheduler_intents WHERE id='m9'").get();
  await deployReconcileTick(f.db, f.config, f.deps);
  expect(getTask(f.db, "T9")?.stage).toBe("live");
  expect(f.db.query("SELECT * FROM task_workflows WHERE taskId='T9'").get()).toEqual(workflow);
  expect(f.db.query("SELECT * FROM scheduler_intents WHERE id='m9'").get()).toEqual(intent);
  expect(listEvents(f.db, { target: "T9" }).some((e) => e.kind === "verify")).toBe(false);
});

test("[验收线 1] concurrent writers cannot append duplicate deployments or observations", async () => {
  for (const mode of ["on", "observe"] as const) {
    const f = fixture(); f.mode(mode); const input = inputOf(f);
    const write = () => writeDeployReconcile(f.db, { actor: "scheduler", now: 300 }, input,
      { repoDir: f.config.projects.p.repoDir, policy: f.deps.policy, assertActive() {} });
    const results = await Promise.allSettled([write(), write()]);
    const events = listEvents(f.db, { target: "T9" });
    if (mode === "on") {
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(events.filter((e) => e.kind === "deploy")).toHaveLength(1);
      expect(events.filter((e) => e.kind === "stage" && e.data.to === "live")).toHaveLength(1);
    } else {
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(events.filter((e) => e.data.mechanism === "deployReconcile")).toHaveLength(1);
    }
  }
});

test("[验收线 1] an existing observe sample still permits on mode to reconcile", async () => {
  const f = fixture(); f.mode("observe");
  await deployReconcileTick(f.db, f.config, f.deps); f.mode("on");
  await deployReconcileTick(f.db, f.config, f.deps);
  expect(getTask(f.db, "T9")?.stage).toBe("live"); expect(f.notices).toHaveLength(1);
});

test("[验收线 1] reader restart cannot repeat an observe sample or its PM notification", async () => {
  const f = fixture(); f.mode("observe");
  await deployReconcileTick(f.db, f.config, f.deps);
  const reader = new Database(f.path, { readonly: true });
  try { await deployReconcileTick(reader, f.config, f.deps); } finally { reader.close(); }
  expect(f.notices).toHaveLength(1); expect(f.calls).toHaveLength(1);
});

test("[验收线 2] invalid git evidence yields the budget cursor so later cards get a turn", async () => {
  const f = fixture();
  f.db.query(`INSERT INTO tasks (id,project,title,kind,stage,headSHA,createdAt,updatedAt)
    SELECT 'Tz',project,title,kind,stage,headSHA,createdAt,updatedAt FROM tasks WHERE id='T9'`).run();
  f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    SELECT 'mz','Tz',project,node,action,causalSeq,eventSeq+1,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt
    FROM scheduler_intents WHERE id='m9'`).run();
  f.db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,mergeSha,createdAt,updatedAt)
    SELECT 'mz','Tz',project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,mergeSha,createdAt,updatedAt FROM scheduler_merges WHERE intentId='m9'`).run();
  f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
    SELECT 160,actor,project,'Tz',kind,text,json_set(data,'$.intentId','mz') FROM events
    WHERE json_extract(data,'$.to')='merged' ORDER BY seq DESC LIMIT 1`).run();
  // A later source event must follow both cards' merges; deliberately point only the first card at an unknown commit.
  deploy(f, { version: f.version });
  f.db.query("UPDATE scheduler_merges SET mergeSha=? WHERE intentId='m9'").run("a".repeat(40));
  f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
    SELECT 170,actor,project,'T9',kind,text,json_set(data,'$.intentId','m9','$.mergeSha',?) FROM events
    WHERE json_extract(data,'$.to')='merged' ORDER BY seq DESC LIMIT 1`).run("a".repeat(40));
  deploy(f, { version: f.version });
  let used = 0;
  const cursor: Record<string, string | undefined> = {};
  await deployReconcileTick(f.db, f.config, f.deps, { cursor, yieldNow: () => used++ > 0, budgetEnded: () => true });
  expect(cursor.deployReconcile).toBe("p/T9");
  used = 0;
  await deployReconcileTick(f.db, f.config, f.deps, { cursor, yieldNow: () => used++ > 0, budgetEnded: () => true });
  expect(getTask(f.db, "Tz")?.stage).toBe("live");
});

test("[验收线 1] registered CLI writes through real policy and held service leases", async () => {
  const f = fixture(), input = inputOf(f);
  writeFileSync(join(f.dir, "scheduler.json"), JSON.stringify(f.config));
  writeFileSync(join(f.dir, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { deployReconcile: "on" } } } }));
  const singleton = await acquireLock(join(f.dir, "scheduler.pid"), 0), maintenance = await acquireLock(join(f.dir, "maintenance"), 0);
  if (!singleton || !maintenance) throw new Error("fixture lease unavailable");
  const args = ["scheduler-deploy-reconcile", "T9", "--rev", String(input.taskRev), "--merge-intent", input.intentId,
    "--merge-rev", String(input.mergeRev), "--source-seq", String(input.sourceSeq)];
  const script = `
    import {runLedger} from './src/manager/ledger.ts';
    import {openLedger} from './src/lib/ledger-store.ts';
    import {assertSchedulerLease} from './src/lib/scheduler-lease-env.ts';
    const result = await runLedger(${JSON.stringify(args)}, {db:openLedger(${JSON.stringify(f.path)}), actor:'scheduler',
      projectIds:['p'], now:()=>300, assertLease:assertSchedulerLease, loadRegistry:async()=>({socket:'',agents:{}}), saveRegistry:async()=>{}});
    console.log(JSON.stringify(result));
  `;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: join(import.meta.dir, ".."),
      env: testChildEnv({ CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_SCHEDULER_SERVICE: "1",
        CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: join(f.dir, "scheduler.pid"), token: singleton.token },
          maintenance: { path: join(f.dir, "maintenance"), token: maintenance.token } }) }), stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toMatchObject({ ok: true, mode: "on", recorded: true });
    expect(getTask(f.db, "T9")?.stage).toBe("live");
  } finally { singleton.release(); maintenance.release(); }
});

test("[验收线 3] historical cards and latest non-merged attempts are not tick candidates", async () => {
  const f = fixture();
  expect(reconcileTaskIds(f.db, "p")).toEqual(["T9"]);
  for (const stage of ["live", "verified", "done"]) {
    f.db.query("UPDATE tasks SET stage=?").run(stage);
    expect(readReconcileFacts(f.db, "T9", 300)).toEqual({ reason: "stage-not-merge" });
    expect(reconcileTaskIds(f.db, "p")).toEqual([]);
    await deployReconcileTick(f.db, f.config, f.deps);
  }
  f.db.query("UPDATE tasks SET stage='merge'").run();
  f.db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    SELECT 'newer',taskId,project,node,action,causalSeq,eventSeq+1,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt
    FROM scheduler_intents WHERE id='m9'`).run();
  f.db.query(`INSERT INTO scheduler_merges
    (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,rev,mergeSha,reason,createdAt,updatedAt)
    SELECT 'newer',taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,'unknown',rev,mergeSha,reason,createdAt,updatedAt
    FROM scheduler_merges WHERE intentId='m9'`).run();
  expect(readReconcileFacts(f.db, "T9", 300)).toEqual({ reason: "merge-not-merged" });
  expect(reconcileTaskIds(f.db, "p")).toEqual([]);
  await deployReconcileTick(f.db, f.config, f.deps);
  await deployReconcileTick(f.db, f.config, f.deps);
  expect([f.calls, f.logs, f.notices]).toEqual([[], [], []]);
  f.db.query("UPDATE scheduler_merges SET phase='merged' WHERE intentId='newer'").run();
  expect(reconcileTaskIds(f.db, "p")).toEqual(["T9"]);
});

test("[验收线 3] skip diagnostics keep stderr empty and are emitted once", async () => {
  const f = fixture(); f.mode("observe");
  f.db.query("UPDATE scheduler_merges SET mergeSha=NULL").run();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  try {
    await deployReconcileTick(f.db, f.config, { ...f.deps, log: undefined });
    await deployReconcileTick(f.db, f.config, { ...f.deps, log: undefined });
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([["[deploy-reconcile] T9: merge-sha-missing"]]);
    expect([f.calls, f.notices]).toEqual([[], []]);
  } finally { warn.mockRestore(); info.mockRestore(); }
});

test("[验收线 1] rollout defaults to observe without a key or project mode", () => {
  const f = fixture(), path = join(f.dir, "recovery-policy.json");
  expect(recoveryPolicy("p", "deployReconcile", path).mode).toBe("observe");
  for (const project of [{}, { keys: { audit: "on" } }]) {
    writeFileSync(path, JSON.stringify({ projects: { p: project } }));
    expect(recoveryPolicy("p", "deployReconcile", path).mode).toBe("observe");
  }
  writeFileSync(path, JSON.stringify({ projects: { p: { mode: "on", keys: { deployReconcile: "observe" } } } }));
  expect(recoveryPolicy("p", "deployReconcile", path).mode).toBe("observe");
});
