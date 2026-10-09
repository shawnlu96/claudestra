/**
 * MTRBUD1: the first-card grant goes to a card that is started. deployTick resumes after its last card, so a running job that
 * only waits does not take the one card every pass from a due verify; in the auto phase, a manual-resume check that resumed nothing
 * does not use up the list's first card, one that did leaves none, and the one card follows the cursor past mergeFirst, however
 * the clock crosses the budget between the list and its first check.
 * Real ledgers and write paths; the clock is a controlled `now` handed to passPace only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { createTask, moveStage, recordVerify } from "../src/lib/ledger-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getTask } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { passPace } from "../src/lib/scheduler-yield.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
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

const STAGES = ["spec", "restate", "build", "review", "merge", "live"];
const stagesThrough = (stage: string) => STAGES.slice(0, STAGES.indexOf(stage) + 1);
function toStage(f: ReturnType<typeof autoFixture>, id: string, stage: string) {
  const path = stagesThrough(stage);
  for (let i = 1; i < path.length; i++) moveStage(f.db, f.at("owner"), { taskId: id, from: path[i - 1] as never, to: path[i] as never });
}
/** M1 is at merge with an unknown merge intent: held every pass, and mergeFirst walks it first. */
function unknownMergeM1(f: ReturnType<typeof autoFixture>, id = "M1", project = "p") {
  createTask(f.db, f.at("owner"), { project, id, title: id, kind: "code" });
  setWorkflow(f.db, f.at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  toStage(f, id, "merge");
  f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,receipt,createdAt,updatedAt)
    VALUES (?,?,?,'merge','merge',1,1,1,1,?,2,'unknown','seed','外部结果不明',300,300)`).run(`m${id.toLowerCase()}`, id, project, "c".repeat(40));
}
const t1Started = (f: ReturnType<typeof autoFixture>) => [f.ensured.length > 0,
  (f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'T1'").get() as { n: number }).n > 0];

/** T0 blocks M1, which went manual waiting for it; T0 is now really verified, so manual-resume (manualStall `mode`) may lift M1. */
async function resumableM1(f: ReturnType<typeof autoFixture>, mode: "on" | "observe") {
  createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
  createTask(f.db, f.at("owner"), { project: "p", id: "M1", title: "M1", kind: "code", agent: "agent-task-one", extra: { fileGlobs: ["src/lib/m.ts"] } });
  addDep(f.db, f.at("owner"), { from: "T0", to: "M1", kind: "blocks", when: "T0 上线后" });
  expect(await f.cli("pm", "workflow-set", "M1", "--rev", "1", "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude",
    "--fallback", "只报错不修", "--reason-code", "deps_not_live", "--reason", "等 T0 上线")).toMatchObject({ ok: true });
  expect(await f.cli("pm", "scheduler-recovery", "p", mode, "--key", "manualStall", "--reason", "MTRBUD1 测试")).toMatchObject({ ok: true });
  toStage(f, "T0", "live");
  recordVerify(f.db, f.at("owner"), { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
}
const m1Mode = (f: ReturnType<typeof autoFixture>) => (f.db.query("SELECT mode FROM task_workflows WHERE taskId = 'M1'").get() as { mode: string }).mode;
const notes = (f: ReturnType<typeof autoFixture>) => (f.db.query("SELECT COUNT(*) AS n FROM events WHERE target = 'M1' AND json_extract(data, '$.op') = 'recovery_observe'").get() as { n: number }).n;
/** One auto pass at a time with budgetMs 1 on the late clock: the phase's floor and the deadline are gone before its first check. */
function passOf(f: ReturnType<typeof autoFixture>, cursor: Record<string, string | undefined>, o: { deps?: typeof f.tickDeps; request?: string } = {}) {
  const late = lateClock();
  return () => schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, o.deps ?? f.tickDeps, passPace(cursor, { budgetMs: 1, now: late, request: o.request }).phase());
}

describe("MTRBUD1 auto phase past its floor: the one card goes round the cursor, and only to a list nothing ahead of it started", () => {
  let saved: Buffer | null = null;
  beforeEach(() => { saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null; rmSync(RECOVERY_POLICY_PATH, { force: true }); });
  afterEach(() => { if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved); else rmSync(RECOVERY_POLICY_PATH, { force: true }); });

  test("old red: M1's merge is unknown and mergeFirst puts it first every pass; T1 still starts, M1 stays held", async () => {
    const f = autoFixture();
    try {
      unknownMergeM1(f);
      const cursor: Record<string, string | undefined> = {}, late = lateClock(), cards: string[][] = [];
      for (let i = 0; i < 3; i++) {
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps, passPace(cursor, { budgetMs: 1, now: late }).phase());
        expect(r.failed).toEqual([]);
        cards.push(r.cards.map((c) => `${c.taskId}:${c.step}`));
      }
      // before: every pass stepped M1 only (held), T1 yielded and the cursor stayed at p/M1
      expect(cards.map((c) => c.map((s) => s.split(":")[0]))).toEqual([["M1"], ["T1"], ["M1"]]);
      expect([cards[0], cards[2]]).toEqual([["M1:held"], ["M1:held"]]);
      expect(t1Started(f)).toEqual([true, true]);
      expect((f.db.query("SELECT status FROM scheduler_intents WHERE id = 'mm1'").get() as { status: string }).status).toBe("unknown");
    } finally { f.close(); }
  });

  test.each([1, 2, 3, 4, 5])("old red: budget boundary same=%i gives T1 finite service", async (same) => {
    // the clock's first `same` readings are equal, every later one is later: the crossing lands on each read up to the grant's own
    // including a first check in budget followed by a second check past it; priority order cannot swallow the next cursor turn
      const f = autoFixture();
      try {
        unknownMergeM1(f);
        const cursor: Record<string, string | undefined> = {}, cards: string[] = [];
        for (let i = 0; i < 40; i++) {
          let n = 0;
          const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
            passPace(cursor, { budgetMs: 1, now: () => 1_000_000 + (++n > same ? 5 * n : 0) }).phase());
          expect(r.failed).toEqual([]);
          cards.push(r.cards.map((c) => c.taskId).join(","));
        }
        // before: the list was built in budget, the grant then went to M1 past it, T1 yielded; every pass M1:held, cursor p/M1
        expect([same, cards]).toEqual([same, Array.from({ length: 40 }, (_, i) => i % 2 ? "T1" : "M1")]);
        expect(t1Started(f)).toEqual([true, true]);
        expect((f.db.query("SELECT status FROM scheduler_intents WHERE id = 'mm1'").get() as { status: string }).status).toBe("unknown");
      } finally { f.close(); }
  });

  test("a saved budget cursor whose card vanished still serves live cards; normal budget retains merge priority", async () => {
    for (const cursor of [{}, { auto: "p/M0", autoBudget: "p/M0" }]) {
      const f = autoFixture();
      try {
        unknownMergeM1(f);
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
          passPace(cursor, { budgetMs: 60_000, now: () => 1_000_000 }).phase());
        expect(r.failed).toEqual([]);
        expect(r.cards.map((c) => c.taskId)).toEqual(["M1", "T1"]);
        expect(t1Started(f)).toEqual([true, true]);
        expect((f.db.query("SELECT status FROM scheduler_intents WHERE id = 'mm1'").get() as { status: string }).status).toBe("unknown");
      } finally { f.close(); }
    }
  });

  test("multiple unknown heads across projects cannot consume every budget turn", async () => {
    const f = autoFixture();
    try {
      unknownMergeM1(f); unknownMergeM1(f, "M2"); unknownMergeM1(f, "N1", "q");
      const cursor: Record<string, string | undefined> = {}, seen: string[] = [];
      const manager = (...args: string[]) => f.cliWith({ projectIds: ["p", "q"], autoProjects: () => ["p", "q"] }, "scheduler", ...args.slice(1));
      for (let i = 0; i < 40; i++) {
        let n = 0;
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 }, q: { maxActiveWorkers: 2 } }, { ...f.tickDeps, manager },
          passPace(cursor, { budgetMs: 1, now: () => 1_000_000 + (++n > 5 ? 5 * n : 0) }).phase());
        expect(r.failed).toEqual([]);
        expect(r.cards).toHaveLength(1);
        seen.push(r.cards[0]!.taskId);
      }
      expect(seen.slice(0, 4)).toEqual(["M1", "M2", "T1", "N1"]);
      expect(t1Started(f)).toEqual([true, true]);
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE status = 'unknown'").get()).toEqual({ n: 3 });
    } finally { f.close(); }
  });

  test("a saved turn rechecks skip and project mode; external yield without a cause cannot create budget debt", async () => {
    for (const change of ["skip", "mode", "project"] as const) {
      const f = autoFixture(), cursor = { auto: "p/M1", autoBudget: "p/M1" as string | undefined };
      try {
        unknownMergeM1(f);
        if (change === "mode") f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'M1'").run();
        if (change === "project") {
          f.db.query("UPDATE tasks SET project = 'q' WHERE id = 'M1'").run();
          f.db.query("UPDATE task_workflows SET project = 'q' WHERE taskId = 'M1'").run();
        }
        const pace = passPace(cursor, { budgetMs: 1, now: lateClock() }).phase();
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
          { ...pace, skipTask: (id) => change === "skip" && id === "M1" });
        expect(r.failed).toEqual([]);
        expect(r.cards.map((c) => c.taskId)).toEqual(["T1"]);
        expect(t1Started(f)).toEqual([true, true]);
      } finally { f.close(); }
    }
    const f = autoFixture(), cursor: Record<string, string | undefined> = { auto: "p/M1", autoBudget: "p/M1" };
    try {
      unknownMergeM1(f); let checks = 0;
      await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
        { cursor, yieldNow: () => ++checks > 1 });
      expect([cursor.auto, cursor.autoBudget, t1Started(f)]).toEqual(["p/M1", undefined, [false, false]]);
    } finally { f.close(); }
  });

  test("invalid budgets never create a marker; update and loss of lease preserve an unserved saved turn", async () => {
    for (const budgetMs of [0, -1, NaN, Infinity]) {
      const pace = passPace({}, { budgetMs, now: lateClock() }).phase();
      pace.yieldNow(); pace.yieldNow();
      expect(pace.budgetEnded?.()).toBe(false);
    }
    const dir = mkdtempSync(join(tmpdir(), "mtrbud1-mid-update-")), request = join(dir, "m.req");
    try {
      const f = autoFixture(), cursor: Record<string, string | undefined> = {};
      try {
        unknownMergeM1(f);
        const pace = passPace(cursor, { budgetMs: 1, now: lateClock(), request }).phase(); let checks = 0;
        await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
          { ...pace, yieldNow: () => { if (++checks === 2) writeFileSync(request, "1"); return pace.yieldNow(); } });
        expect([cursor.auto, cursor.autoBudget, t1Started(f)]).toEqual(["p/M1", undefined, [false, false]]);
        cursor.autoBudget = cursor.auto;
        await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
          passPace(cursor, { budgetMs: 1, now: lateClock(), request }).phase());
        expect([cursor.auto, cursor.autoBudget, t1Started(f)]).toEqual(["p/M1", "p/M1", [false, false]]);
        rmSync(request);
        await expect(schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps,
          { cursor, yieldNow: () => { throw new SchedulerStopped("lease lost"); } })).rejects.toBeInstanceOf(SchedulerStopped);
        expect([cursor.auto, cursor.autoBudget, t1Started(f)]).toEqual(["p/M1", "p/M1", [false, false]]);
      } finally { f.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the one card past the budget is the last: no second card starts in the phase, even on a clock that turns back", () => {
    let t = 1_000_000;
    const pace = passPace({}, { budgetMs: 1, now: () => t }).phase();
    t += 5;
    expect([pace.yieldNow(), pace.lastCard?.()]).toEqual([false, true]);
    t -= 5;
    expect(pace.yieldNow()).toBe(true);
    const inBudget = passPace({}, { budgetMs: 60_000, now: () => t }).phase();
    expect([inBudget.yieldNow(), inBudget.lastCard?.(), inBudget.yieldNow()]).toEqual([false, false, false]); // in budget: the order as is
  });

  test("old red: manual-resume really resumes M1; T1 waits for the next pass instead of a second grant", async () => {
    const f = autoFixture();
    try {
      await resumableM1(f, "on");
      const cursor: Record<string, string | undefined> = { auto: "p/M1" }, pass = passOf(f, cursor);
      expect((await pass()).failed).toEqual([]);
      // before: M1 resumed and then T1 got a second grant past deadline and floor (planned, author session ensured)
      expect([m1Mode(f), t1Started(f), cursor.auto]).toEqual(["auto", [false, false], "p/M1"]);
      expect((await pass()).failed).toEqual([]); // nothing ran ahead of the list: its first card, next after the cursor
      expect([t1Started(f), cursor.auto]).toEqual([[true, true], "p/T1"]);
    } finally { f.close(); }
  });

  test("observe: a new would-resume note is the phase's card; the next pass's deduplicated check leaves T1 its card", async () => {
    const f = autoFixture();
    try {
      await resumableM1(f, "observe");
      const cursor: Record<string, string | undefined> = { auto: "p/M1" }, pass = passOf(f, cursor);
      expect((await pass()).failed).toEqual([]);
      expect([m1Mode(f), notes(f), t1Started(f)]).toEqual(["manual", 1, [false, false]]);
      expect((await pass()).failed).toEqual([]);
      expect([m1Mode(f), notes(f), t1Started(f)]).toEqual(["manual", 1, [true, true]]);
    } finally { f.close(); }
  });

  test("a resume the transaction refuses started nothing: T1 starts; an error ahead of the list or a waiting update: no card", async () => {
    const on = () => ({ mode: "on" as const, manualAfterMs: null, source: "config" as const });
    const f = autoFixture();
    try { // the tick's port says on, the ledger's own policy (observe) refuses the write inside the transaction
      await resumableM1(f, "observe");
      const cursor: Record<string, string | undefined> = { auto: "p/M1" };
      expect((await passOf(f, cursor, { deps: { ...f.tickDeps, recoveryPolicy: on } })()).failed).toEqual([]);
      expect([m1Mode(f), t1Started(f), cursor.auto]).toEqual(["manual", [true, true], "p/T1"]);
    } finally { f.close(); }
    const g = autoFixture();
    try { // not a business refusal: the pre-step's outcome is unknown, so the list gets no second card
      await resumableM1(g, "on");
      const manager = async (...args: string[]) => args[1] === "scheduler-manual-resume" ? { ok: false, code: "invalid", error: "写锁坏了" } : g.tickDeps.manager(...args);
      const r = await passOf(g, { auto: "p/M1" }, { deps: { ...g.tickDeps, manager } })();
      expect([r.failed.map((x) => x.taskId), m1Mode(g), t1Started(g)]).toEqual([["manual-resume"], "manual", [false, false]]);
    } finally { g.close(); }
    const dir = mkdtempSync(join(tmpdir(), "mtrbud1-req-")), request = join(dir, "m.req"), h = autoFixture();
    try {
      writeFileSync(request, "1");
      await resumableM1(h, "on");
      expect((await passOf(h, { auto: "p/M1" }, { request })()).failed).toEqual([]);
      expect([m1Mode(h), t1Started(h)]).toEqual(["manual", [false, false]]);
    } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
