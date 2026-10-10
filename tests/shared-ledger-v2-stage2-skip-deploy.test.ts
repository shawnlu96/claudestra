/**
 * S2D2C · deployTick on the unified skip gate (S2D2 spec「PM 定 · 21:3x」, E26). A card in a `migrating` / `execution` feature whose
 * deploy is in flight is only observed: over three ticks of the real step, behind the real S2G write gate (runLedger in-process)
 * and the pass manager's skip gate, it gets 0 ledger writes, 0 job calls and no exception, one diagnostic and one PM notice; another
 * card of the same project still ticks (verify). `deployInFlight` stays true on purpose (other deploys wait for the reconcile).
 * Control: a local card's in-flight deploy is driven to its settle as before, and so is the held one once the feature is local again.
 * Old red: main's in-flight loop skipped the row silently with the pass pace (0 diagnostics, 0 notices) and drove it without one.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { deployInFlight, getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { createTask, recordVerify } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { configureSchedulerV2Pass, schedulerV2PassPace, type SchedulerV2FeatureMode } from "../src/lib/scheduler-v2-pass.js";
import { schedulerV2SkipManager } from "../src/lib/scheduler-v2-skip.js";
import { passPace } from "../src/lib/scheduler-yield.js";
import { ledgerAs, mergedCard, type MergedCard } from "./deploy-test-kit.js";

const LABEL = `com.claudestra.scheduler.deploy.${"f".repeat(32)}`;
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };
const MIGRATING: SchedulerV2FeatureMode = { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "batch", kind: "execute" } };
const EXECUTION: SchedulerV2FeatureMode = { authorityMode: "execution", sharedPlanning: true };
const PLANNING: SchedulerV2FeatureMode = { authorityMode: "planning", sharedPlanning: true };

const cleanups: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Pass(null); while (cleanups.length) cleanups.pop()!(); });

let seq = 0;
/** T9's deploy is running (its job finished fine, so a driven tick would settle it); L is an auto card live on a deployed row of its
 *  own merge, due for verify. L's intent id is fresh per world: verify pacing is kept per intent for the process. */
function world(): MergedCard & { verifyL: string } {
  const f = mergedCard(), mL = `mL${++seq}`, HL = "e".repeat(40), PR = "https://github.com/example/repo/pull/8";
  cleanups.push(() => f.close());
  f.db.query("INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,label,createdAt,updatedAt) SELECT 'm9','T9','p',pr,?,'running',?,1,1 FROM tasks WHERE id='T9'")
    .run("d".repeat(40), LABEL);
  const owner = { actor: "owner", now: 100 };
  createTask(f.db, owner, { project: "p", id: "L", title: "live", kind: "code", agent: "agent-author" });
  setWorkflow(f.db, owner, { taskId: "L", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  f.db.query("UPDATE tasks SET stage='live', round=1, rev=rev+1, headSHA=?, pr=? WHERE id='L'").run(HL, PR);
  f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,'L','p','merge_deploy','merge',1,9,2,1,?,2,'done','seed',100,100)`).run(mL, HL);
  f.db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,rev,mergeSha,createdAt,updatedAt)
    VALUES (?,'L','p',?,'feat/l',?,'["ci"]','merged',4,?,100,100)`).run(mL, PR, HL, HL);
  f.db.query(`INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,outcome,liveness,deployedAt,createdAt,updatedAt)
    VALUES (?,'L','p',?,?,'deployed','success','dead',950,1,1)`).run(mL, PR, HL);
  return Object.assign(f, { verifyL: `L --dedup deploy-verify:${mL}` });
}

/** Binds cards to features and writes the mode file next to the ledger (the file both the route and S2G's gate read). */
function bind(db: Database, cards: Record<string, SchedulerV2FeatureMode>): void {
  const modes: Record<string, SchedulerV2FeatureMode> = {};
  for (const [taskId, mode] of Object.entries(cards)) {
    db.query("INSERT OR IGNORE INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES (?,'p',?,'active','owner',1,1)").run(`f-${taskId}`, taskId);
    db.query("UPDATE tasks SET featureId=? WHERE id=?").run(`f-${taskId}`, taskId);
    modes[`f-${taskId}`] = mode;
  }
  writeFileSync(join(dirname(db.filename), "shared-ledger-modes.json"), JSON.stringify({ features: modes }));
}

function harness(f: MergedCard) {
  const jobLog: string[] = [], inner: string[][] = [], notices: string[] = [], verify: string[] = [];
  const view = { label: LABEL, liveness: "dead" as const, result: { ok: true, summary: "部署到 dddd" }, deadline: 10_000 };
  const jobs: DeployJobs = {
    label: () => LABEL,
    submit: async () => { jobLog.push("submit"); return LABEL; },
    observe: async (run) => { jobLog.push(`observe ${run.taskId}`); return view; },
    remove: async (l) => { jobLog.push(`remove ${l}`); return true; },
  };
  const ledger = ledgerAs(f.db, "scheduler", () => 1000);
  const real = async (...args: string[]): Promise<Record<string, unknown>> => {
    inner.push(args);
    if (args[1] !== "verify") return ledger(...args);
    verify.push(args.slice(2).join(" "));
    if (args.includes("--dry-run")) return { ok: true, result: "pass" };
    // the real write path behind S2G; only the fact collection (gh, lsof, ps) is skipped
    const r = recordVerify(f.db, { actor: "scheduler", now: 1000, dedupKey: args[4] }, { taskId: args[2]!, result: "pass",
      data: { checks: [{ id: "pr-merged", status: "pass" }], incomplete: false } });
    return { ok: true, moved: true, task: r.row };
  };
  const deps = { manager: schedulerV2SkipManager(f.db, real), jobs, assertActive: () => {}, now: () => 1000,
    notifyPm: async (project: string, text: string) => { notices.push(`${project} ${text}`); } };
  const info = spyOn(console, "info").mockImplementation(() => {});
  cleanups.push(() => info.mockRestore());
  const diagnostics = () => info.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("[scheduler-v2 held] deploy"));
  // each tick is one pass: a fresh pace (which also clears the pass-scoped diagnostic dedupe), as schedulerPass builds it
  const tick = (paced = true) => deployTick(f.db, config, deps, paced ? schedulerV2PassPace(f.db, passPace({})).phase() : undefined);
  return { jobLog, inner, notices, verify, diagnostics, tick };
}

const eventsOf = (db: Database, id: string) => (db.query("SELECT COUNT(*) AS n FROM events WHERE target=?").get(id) as { n: number }).n;
const rowOf = (db: Database) => db.query("SELECT phase, rev, updatedAt FROM scheduler_deploys WHERE intentId='m9'").get();

describe("S2D2C deploy tick: a skip card's in-flight deploy is only observed", () => {
  for (const [label, mode] of [["migrating", MIGRATING], ["execution", EXECUTION]] as const) {
    test(`${label}: 3 ticks → 0 writes, 0 job calls, no throw, 1 diagnostic, 1 notice; L still verifies; deployInFlight stays true`, async () => {
      const f = world(), h = harness(f);
      bind(f.db, { T9: mode });
      const events = eventsOf(f.db, "T9"), row = rowOf(f.db);
      for (let i = 0; i < 3; i++) await h.tick();
      expect(eventsOf(f.db, "T9")).toBe(events);
      expect(rowOf(f.db)).toEqual(row);
      expect(h.inner.filter((a) => a.includes("T9") || a.includes("m9"))).toEqual([]);
      expect(h.jobLog).toEqual([]);
      expect(h.diagnostics()).toHaveLength(1);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(/^p .*部署被卡 T9 挡住：feature 在 migrating \/ execution，本机不能结账/);
      expect(deployInFlight(f.db)).toBe(true); // intentional: no concurrent deploy until the row is reconciled (X13 precheck, E26)
      expect(h.verify).toEqual(["L --dry-run", f.verifyL]);
      expect(f.db.query("SELECT stage FROM tasks WHERE id='L'").get()).toEqual({ stage: "verified" });
    });
  }

  test("deployTick run without a pace asks the unified gate itself: still 0 writes and no throw", async () => {
    const f = world(), h = harness(f);
    bind(f.db, { T9: MIGRATING });
    const events = eventsOf(f.db, "T9"), row = rowOf(f.db);
    for (let i = 0; i < 3; i++) await h.tick(false);
    expect([eventsOf(f.db, "T9"), rowOf(f.db), h.jobLog]).toEqual([events, row, []]);
    expect([h.diagnostics().length, h.notices.length]).toEqual([1, 1]);
  });

  test("a lost notice is logged, not thrown, and not retried every tick", async () => {
    const f = world(), h = harness(f);
    bind(f.db, { T9: MIGRATING });
    const err = spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => err.mockRestore());
    let tries = 0;
    const deps = { manager: async () => ({ ok: true }), jobs: {} as DeployJobs, assertActive: () => {}, now: () => 1000,
      notifyPm: async () => { tries++; throw new Error("bridge down"); } };
    for (let i = 0; i < 3; i++) await deployTick(f.db, config, deps, schedulerV2PassPace(f.db, passPace({})).phase());
    expect(tries).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("bridge down"))).toHaveLength(1);
    expect(h.jobLog).toEqual([]);
  });

  test("control: a local card's in-flight deploy is driven to its settle as before (mode file present, its feature local)", async () => {
    const f = world(), h = harness(f);
    bind(f.db, { T9: PLANNING });
    await h.tick();
    expect(getDeployRun(f.db, "m9")).toMatchObject({ phase: "deployed", outcome: "success" });
    expect(f.db.query("SELECT stage FROM tasks WHERE id='T9'").get()).toEqual({ stage: "verified" }); // live, then verified in the same tick
    expect(h.jobLog).toEqual(["observe T9", `remove ${LABEL}`]);
    expect([h.diagnostics().length, h.notices.length]).toEqual([0, 0]);
    expect(deployInFlight(f.db)).toBe(false);
  });

  test("once the feature is local again the held row is driven to its settle on the next tick", async () => {
    const f = world(), h = harness(f);
    bind(f.db, { T9: MIGRATING });
    await h.tick();
    expect(getDeployRun(f.db, "m9")?.phase).toBe("running");
    bind(f.db, { T9: PLANNING });
    await h.tick();
    expect(getDeployRun(f.db, "m9")).toMatchObject({ phase: "deployed", outcome: "success" });
    expect(deployInFlight(f.db)).toBe(false);
  });
});
