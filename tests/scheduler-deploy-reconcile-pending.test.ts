/** DEPRECON2: an auto card still waiting for its own auto deploy is not a deployReconcile candidate. */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { appendEvent } from "../src/lib/ledger-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { mergedCard, type MergedCard } from "./deploy-test-kit.js";
import { deployDrift } from "../src/lib/scheduler-deploy.js";
import { deployReconcileTick } from "../src/lib/scheduler-deploy-reconcile.js";
import { writeDeployReconcile } from "../src/lib/scheduler-deploy-reconcile-write.js";
import { readReconcileFacts, reconcileTaskIds } from "../src/lib/scheduler-deploy-reconcile-facts.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const cards: MergedCard[] = [];
afterEach(() => { for (const c of cards.splice(0)) c.close(); });

/** Auto card merged with intent m9 still submitted, plus a newer successful deployment that contains its merge commit. */
function fixture() {
  const c = mergedCard(); cards.push(c);
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
  const policy: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: null, source: "default" });
  const notices: string[] = [], logs: string[] = [];
  const deps = { policy, assertActive() {}, now: () => 300, log: (s: string) => { logs.push(s); },
    notifyPm: async (_project: string, s: string) => { notices.push(s); },
    manager: async (...args: string[]) => {
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      return writeDeployReconcile(c.db, { actor: "scheduler", now: 300 }, { taskId: args[2]!, taskRev: Number(value("--rev")),
        intentId: value("--merge-intent"), mergeRev: Number(value("--merge-rev")), sourceSeq: Number(value("--source-seq")) },
      { repoDir, policy, assertActive() {} });
    } };
  const observed = () => listEvents(c.db, { target: "T9" }).filter((e) => e.data.mechanism === "deployReconcile");
  return { ...c, repoDir, config, deps, policy, notices, logs, observed };
}

test("[红测1] auto card awaiting its own deploy is not a candidate and observe records nothing", async () => {
  const f = fixture();
  expect(deployDrift(f.db, "m9")).toBeNull();
  expect(reconcileTaskIds(f.db, "p")).toEqual([]);
  expect(readReconcileFacts(f.db, "T9", 300)).toEqual({ reason: "auto-deploy-pending" });
  const task = getTask(f.db, "T9");
  await deployReconcileTick(f.db, f.config, f.deps); await deployReconcileTick(f.db, f.config, f.deps);
  expect(f.observed()).toHaveLength(0);
  expect(f.notices).toHaveLength(0);
  expect(getTask(f.db, "T9")).toEqual(task);
});

test("[红测1] the write-side recheck refuses the same card", async () => {
  const f = fixture();
  const merge = f.db.query("SELECT rev FROM scheduler_merges WHERE intentId='m9'").get() as { rev: number };
  const source = listEvents(f.db, {}).findLast((e) => e.kind === "deploy")!;
  await expect(writeDeployReconcile(f.db, { actor: "scheduler", now: 300 }, { taskId: "T9", taskRev: getTask(f.db, "T9")!.rev,
    intentId: "m9", mergeRev: merge.rev, sourceSeq: source.seq }, { repoDir: f.repoDir, policy: f.policy, assertActive() {} }))
    .rejects.toThrow("auto-deploy-pending");
  expect(f.observed()).toHaveLength(0);
});

test("[保持] manual merge card (intent settled) stays a candidate and observe records it", async () => {
  const f = fixture();
  f.db.query("UPDATE scheduler_intents SET status='done' WHERE id='m9'").run();
  expect(reconcileTaskIds(f.db, "p")).toEqual(["T9"]);
  await deployReconcileTick(f.db, f.config, f.deps);
  expect(f.observed()).toHaveLength(1);
  expect(f.notices).toHaveLength(1);
});

test("[保持] auto card with intent submitted but a paused workflow (deployDrift non-null) stays a candidate", async () => {
  const f = fixture();
  f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T9'").run();
  expect(deployDrift(f.db, "m9")).not.toBeNull();
  expect(reconcileTaskIds(f.db, "p")).toEqual(["T9"]);
  await deployReconcileTick(f.db, f.config, f.deps);
  expect(f.observed()).toHaveLength(1);
});
