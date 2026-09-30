import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { deployTick, VERIFY_WINDOW_MS } from "../src/lib/scheduler-deploy-tick.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const LABEL = `com.claudestra.scheduler.deploy.${"f".repeat(32)}`;
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };

type View = Awaited<ReturnType<DeployJobs["observe"]>>;
/** Scripted jobs: `view` is what observe answers next; every call is logged. */
function fakeJobs(view: View = null) {
  const log: string[] = [];
  const s = { view, submitError: null as Error | null, log };
  const jobs: DeployJobs = {
    submit: async () => { log.push("submit"); if (s.submitError) throw s.submitError; s.view = { label: LABEL, liveness: "alive", result: null, deadline: 10_000 }; return LABEL; },
    observe: async () => { log.push("observe"); return s.view; },
    remove: async (l) => { log.push(`remove ${l}`); return true; },
  };
  return { s, jobs };
}

function deps(db: Database, jobs: DeployJobs, o: { now?: number; verify?: string[]; active?: () => void } = {}) {
  const now = () => o.now ?? 1000, ledger = ledgerAs(db, "scheduler", now);
  const manager = async (...args: string[]) => {
    if (args[1] === "verify") {
      o.verify?.push(args.slice(2).join(" "));
      if (args.includes("--dry-run")) return { ok: true, result: "pass" };
      db.query("UPDATE tasks SET stage='verified' WHERE id=?").run(args[2]);
      db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1,'scheduler','p',?,'verify','','{}',?)").run(args[2], args[4]);
      return { ok: true, moved: true };
    }
    return ledger(...args);
  };
  return { manager, jobs, assertActive: o.active ?? (() => {}), now };
}

describe("T68g deploy tick", () => {
  test("merged → claimed → running → deployed (live) → verify → verified, with no human step", async () => {
    const f = mergedCard(), j = fakeJobs(), verify: string[] = [];
    try {
      await deployTick(f.db, config, deps(f.db, j.jobs));
      expect(getDeployRun(f.db, f.intent)).toMatchObject({ phase: "running", label: LABEL });
      expect(j.s.log.filter((x) => x === "submit")).toHaveLength(1);
      await deployTick(f.db, config, deps(f.db, j.jobs)); // still alive: nothing moves, nothing resubmitted
      expect(getDeployRun(f.db, f.intent)?.phase).toBe("running");
      j.s.view = { label: LABEL, liveness: "dead", result: { ok: true, summary: "部署到 dddd" }, deadline: 10_000 };
      await deployTick(f.db, config, deps(f.db, j.jobs, { verify }));
      expect(f.db.query("SELECT stage FROM tasks WHERE id='T9'").get()).toEqual({ stage: "verified" });
      expect(verify).toEqual(["T9 --dry-run", "T9 --dedup scheduler:m9:verify"]);
      expect(j.s.log).toContain(`remove ${LABEL}`);
      expect(j.s.log.filter((x) => x === "submit")).toHaveLength(1);
    } finally { f.close(); }
  });

  test("merge tick leaves a merged run to the deploy step when the project deploys", async () => {
    const f = mergedCard();
    try {
      await mergeTick(f.db, config, deps(f.db, fakeJobs().jobs).manager, () => { throw new Error("no gh"); }, () => {});
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='m9'").get()).toEqual({ status: "submitted" });
      const mergeOnly = { ...config, projects: { p: { ...config.projects.p, deploy: undefined } } };
      await mergeTick(f.db, mergeOnly, deps(f.db, fakeJobs().jobs).manager, () => { throw new Error("no gh"); }, () => {});
      expect(f.db.query("SELECT status FROM scheduler_intents WHERE id='m9'").get()).toEqual({ status: "done" });
    } finally { f.close(); }
  });

  test("P1: past the deadline a live job is booted out, and only a later tick that sees it dead writes unknown", async () => {
    const f = mergedCard(), j = fakeJobs();
    try {
      await deployTick(f.db, config, deps(f.db, j.jobs));
      await deployTick(f.db, config, deps(f.db, j.jobs, { now: 20_000 }));
      expect(j.s.log).toContain(`remove ${LABEL}`);
      expect(getDeployRun(f.db, f.intent)?.phase).toBe("running");
      j.s.view = { label: LABEL, liveness: "unreadable", result: null, deadline: 10_000 };
      await deployTick(f.db, config, deps(f.db, j.jobs, { now: 21_000 }));
      expect(getDeployRun(f.db, f.intent)?.phase).toBe("running"); // launchd unreadable is never "dead"
      j.s.view = { label: LABEL, liveness: "dead", result: null, deadline: 10_000 };
      await deployTick(f.db, config, deps(f.db, j.jobs, { now: 22_000 }));
      expect(getDeployRun(f.db, f.intent)).toMatchObject({ phase: "unknown", outcome: "unknown", liveness: "dead" });
    } finally { f.close(); }
  });

  test("a failed deploy is unknown with its reason and is never retried", async () => {
    const f = mergedCard(), j = fakeJobs();
    try {
      await deployTick(f.db, config, deps(f.db, j.jobs));
      j.s.view = { label: LABEL, liveness: "dead", result: { ok: false, summary: "web-release 失败（exit 1）" }, deadline: 10_000 };
      await deployTick(f.db, config, deps(f.db, j.jobs));
      await deployTick(f.db, config, deps(f.db, j.jobs));
      expect(getDeployRun(f.db, f.intent)).toMatchObject({ phase: "unknown", outcome: "failed", reason: expect.stringMatching(/web-release/) });
      expect(j.s.log.filter((x) => x === "submit")).toHaveLength(1);
    } finally { f.close(); }
  });

  test("P1 lost lease: no submit after the service stopped; a submit that failed without a job is unknown, not retried", async () => {
    const f = mergedCard(), j = fakeJobs();
    try {
      const stopped = () => { throw new SchedulerStopped("stop"); };
      await expect(deployTick(f.db, config, deps(f.db, j.jobs, { active: stopped }))).rejects.toThrow(SchedulerStopped);
      expect(j.s.log).not.toContain("submit");
      expect(getDeployRun(f.db, f.intent)?.phase).toBe("claimed");
      j.s.submitError = new Error("launchctl bootstrap exit 5");
      await deployTick(f.db, config, deps(f.db, j.jobs));
      expect(getDeployRun(f.db, f.intent)).toMatchObject({ phase: "unknown", outcome: "failed", reason: expect.stringMatching(/bootstrap/) });
    } finally { f.close(); }
  });

  test("a card paused before submit is not deployed; a claim that already has a job is recorded, not resubmitted", async () => {
    const f = mergedCard(), j = fakeJobs();
    try {
      f.db.query("INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,createdAt,updatedAt) SELECT 'm9','T9','p',pr,?,'claimed',1,1 FROM tasks WHERE id='T9'")
        .run("d".repeat(40));
      j.s.view = { label: LABEL, liveness: "alive", result: null, deadline: 10_000 };
      await deployTick(f.db, config, deps(f.db, j.jobs));
      expect(getDeployRun(f.db, f.intent)).toMatchObject({ phase: "running", label: LABEL });
      expect(j.s.log).not.toContain("submit");
    } finally { f.close(); }
  });

  test("verify waits out a failing dry-run inside the window, then records once", async () => {
    const f = mergedCard(), j = fakeJobs({ label: LABEL, liveness: "dead", result: { ok: true, summary: "ok" }, deadline: 10_000 });
    try {
      f.db.query("INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,label,createdAt,updatedAt) SELECT 'm9','T9','p',pr,?,'running',?,1,1 FROM tasks WHERE id='T9'")
        .run("d".repeat(40), LABEL);
      const calls: string[] = [];
      const d = deps(f.db, j.jobs, { now: 5_000_000 });
      const failing = { ...d, manager: async (...a: string[]) => { if (a[1] === "verify") { calls.push(a.slice(2).join(" ")); return { ok: true, result: "fail" }; } return d.manager(...a); } };
      await deployTick(f.db, config, failing);
      expect(calls).toEqual(["T9 --dry-run"]);
      expect(f.db.query("SELECT stage FROM tasks WHERE id='T9'").get()).toEqual({ stage: "live" });
      await deployTick(f.db, config, { ...failing, now: () => 5_000_000 + VERIFY_WINDOW_MS + 1 });
      expect(calls.at(-1)).toBe("T9 --dedup scheduler:m9:verify");
    } finally { f.close(); }
  });
});
