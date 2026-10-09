/**
 * MTRBUD1 r1: the first-card grant goes to a card that is started. deployTick resumes after its last card, so a running job that
 * only waits does not take the one card every pass from a due verify; in the auto phase, manual-resume's check ahead of the card
 * list does not use up the list's first card. Real ledgers and write paths; the clock is a controlled `now` handed to passPace only.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { createTask, recordVerify } from "../src/lib/ledger-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { passPace } from "../src/lib/scheduler-yield.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

/** Every reading is 5 ms later: each phase's floor and the pass deadline are gone before the phase's first check. */
const lateClock = () => { let t = 1_000_000; return () => (t += 5); };
const LABEL = `com.claudestra.scheduler.deploy.${"f".repeat(32)}`;
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };

function fakeJobs() {
  const log: string[] = [];
  const s = { view: null as Awaited<ReturnType<DeployJobs["observe"]>>, log };
  const jobs: DeployJobs = { label: () => LABEL, observe: async () => { log.push("observe"); return s.view; }, remove: async (l) => { log.push(`remove ${l}`); return true; },
    submit: async () => { log.push("submit"); s.view = { label: LABEL, liveness: "alive", result: null, deadline: 10_000 }; return LABEL; } };
  return { s, jobs };
}

/** The ledger CLI as the scheduler; `ledger verify` keeps its real write path, only the fact collection (gh, lsof, ps) is skipped. */
function deps(db: Database, jobs: DeployJobs, now: number, dry: "pass" | "fail", verify: string[] = []) {
  const ledger = ledgerAs(db, "scheduler", () => now);
  const manager = async (...args: string[]) => {
    if (args[1] !== "verify") return ledger(...args);
    verify.push(args.slice(2).join(" "));
    if (args.includes("--dry-run")) return { ok: true, result: dry };
    const r = recordVerify(db, { actor: "scheduler", now, dedupKey: args[4] }, { taskId: args[2], result: "pass",
      data: { checks: [{ id: "pr-merged", status: "pass" }], incomplete: false } });
    return { ok: true, moved: true, task: r.row };
  };
  return { manager, jobs, assertActive: () => {}, now: () => now };
}

describe("MTRBUD1 deploy phase past its floor: a running job that only waits does not starve a due verify", () => {
  test("old red: T9 is live and due, T8's job is unreadable every pass; both get turns and T9 is verified", async () => {
    const f = mergedCard(), j = fakeJobs(), verify: string[] = [];
    try {
      await deployTick(f.db, config, deps(f.db, j.jobs, 1000, "fail")); // T9: claimed → running
      j.s.view = { label: LABEL, liveness: "dead", result: { ok: true, summary: "部署到 dddd" }, deadline: 10_000 };
      await deployTick(f.db, config, deps(f.db, j.jobs, 1000, "fail")); // deployed and live; the dry-run fails, the try is spent
      expect([getDeployRun(f.db, "m9")?.phase, getTask(f.db, "T9")?.stage]).toEqual(["deployed", "live"]);
      // T8 holds the global deploy slot with a job whose launchd state cannot be read: never taken for dead
      createTask(f.db, { actor: "owner", now: 300 }, { project: "p", id: "T8", title: "running", kind: "code" });
      f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        VALUES ('m8','T8','p','merge_deploy','merge',1,9,1,1,?,2,'submitted','seed',300,300)`).run("c".repeat(40));
      f.db.query(`INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,label,createdAt,updatedAt)
        VALUES ('m8','T8','p','pr',?,'running',?,300,300)`).run("e".repeat(40), LABEL);
      j.s.view = { label: LABEL, liveness: "unreadable", result: null, deadline: 10_000 };
      j.s.log.length = 0;
      const cursor: Record<string, string | undefined> = {}, late = lateClock(), handled: number[] = [];
      for (let i = 0; i < 3; i++) {
        handled.push(await deployTick(f.db, config, deps(f.db, j.jobs, 62_000, "pass", verify), passPace(cursor, { budgetMs: 1, now: late }).phase()));
      }
      // before: every pass observed T8 and returned at T9's check ([1, 1, 1], no verify, T9 live for good)
      expect(handled).toEqual([1, 1, 1]);
      expect(verify).toEqual(["T9 --dry-run", "T9 --dedup deploy-verify:m9"]);
      expect(getTask(f.db, "T9")?.stage).toBe("verified");
      expect([getDeployRun(f.db, "m8")?.phase, j.s.log]).toEqual(["running", ["observe", "observe"]]); // still waited for; nothing submitted or removed
    } finally { f.close(); }
  });
});

describe("MTRBUD1 auto phase past its floor: manual-resume's check ahead of the cards does not use up the first card", () => {
  const observe = () => ({ mode: "observe" as const, manualAfterMs: null, source: "config" as const });
  test("old red: owner-held M1 is checked and refused, T1 still starts; M1 stays manual", async () => {
    const f = autoFixture();
    try {
      createTask(f.db, f.at("owner"), { project: "p", id: "M1", title: "M1", kind: "code" });
      expect(await f.cli("pm", "workflow-set", "M1", "--rev", "1", "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude",
        "--fallback", "只报错不修", "--reason", "owner 要亲自盯")).toMatchObject({ ok: true });
      const cursor: Record<string, string | undefined> = {};
      const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, recoveryPolicy: observe },
        passPace(cursor, { budgetMs: 1, now: lateClock() }).phase());
      // before: manual-resume took the grant on M1, T1 yielded every pass (no card, cursor {})
      expect([r.failed, cursor.auto, f.ensured.length > 0, f.intents().length > 0]).toEqual([[], "p/T1", true, true]);
      expect((f.db.query("SELECT mode FROM task_workflows WHERE taskId = 'M1'").get() as { mode: string }).mode).toBe("manual");
    } finally { f.close(); }
  });

  test("an update waiting or a zero budget: no auto card starts, as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mtrbud1-req-")), request = join(dir, "m.req");
    writeFileSync(request, "1");
    try {
      for (const opts of [{ budgetMs: 1, request }, { budgetMs: 0 }]) {
        const f = autoFixture();
        try {
          const cursor: Record<string, string | undefined> = {};
          await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, recoveryPolicy: observe },
            passPace(cursor, { ...opts, now: lateClock() }).phase());
          expect([cursor.auto, f.ensured, f.intents()]).toEqual([undefined, [], []]);
        } finally { f.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
