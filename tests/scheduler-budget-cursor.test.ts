/**
 * MTRBUD2: the merge / deploy cursors are committed only when the pass budget really cuts a phase off. A pass that gets through
 * clears them, any other exit (update, an outside pace, an invalid budget, a throw) leaves them as the pass found them; merge
 * goes in scheduler.json's project order, then eventSeq. The auto phase's owed-card contract is locked as it is (He's P2-2).
 * Real ledgers; the merge / deploy side effects are faked at the manager and job ports; the clock is a `now` handed to passPace only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { passPace, type TickPace } from "../src/lib/scheduler-yield.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type Cursor = Record<string, string | undefined>;
/** Every reading is 5 ms later: each phase's floor and the pass deadline are gone before the phase's first check. */
const lateClock = () => { let t = 1_000_000; return () => (t += 5); };
const still = () => 1_000_000;
/** One card a pass: the first check is granted, the next one yields for the budget. */
const cut = (cursor: Cursor) => passPace(cursor, { budgetMs: 1, now: lateClock() }).phase();
const ample = (cursor: Cursor) => passPace(cursor, { budgetMs: 60_000, now: still }).phase();
/** An outside pace (no budgetEnded) that lets `n` cards through, then yields. */
const outside = (cursor: Cursor, n: number): TickPace => { let i = 0; return { cursor, yieldNow: () => i++ >= n }; };

/** A ledger with merge intents in the given projects (scheduler.json order as listed); the manager claims and fails every begin,
 *  so each intent is a started card that leaves the ledger as it was. `claimed` lists the intents started, in order. */
function mergeWorld(projects: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "mtrbud2-m-")), db = openLedger(join(dir, "ledger.sqlite"));
  const config = parseSchedulerConfig({ enabled: true, autoDispatch: true,
    projects: Object.fromEntries(projects.map((p) => [p, { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: `/tmp/${p}` }])) });
  const claimed: string[] = [];
  let stop: string | null = null, after: (() => void) | null = null;
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    if (args[1] === "scheduler-settle" && args.includes("submitted") && args[args.indexOf("--to") + 1] === "submitted") {
      if (stop === args[2]) throw new SchedulerStopped("服务停止");
      claimed.push(args[2]);
      after?.();
      return { ok: true };
    }
    if (args[1] === "scheduler-merge-begin") return { ok: false, error: "测试里不开合并" };
    return { ok: true };
  };
  const intent = (project: string, id: string, eventSeq: number) => {
    createTask(db, { actor: "owner", now: 100 }, { project, id: `T-${id}`, title: id, kind: "code" });
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,?,'merge_deploy','merge',1,?,1,1,?,2,'pending','seed',100,100)`).run(id, `T-${id}`, project, eventSeq, "c".repeat(40));
  };
  const pass = async (pace?: TickPace) => {
    const before = claimed.length;
    await mergeTick(db, config, manager, () => { throw new Error("不驱动合并"); }, () => {}, pace, null);
    return claimed.slice(before);
  };
  return { db, intent, pass, claimed, stopAt: (id: string | null) => { stop = id; }, afterClaim: (f: (() => void) | null) => { after = f; },
    close: () => { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); } };
}

describe("MTRBUD2 merge cursor: committed only on a budget cut-off", () => {
  test("[验收线 1] old red: a 60s budget on a still clock, NaN and Infinity go through every intent and leave no cursor", async () => {
    for (const budgetMs of [60_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const w = mergeWorld(["p"]);
      try {
        for (const [id, seq] of [["a", 1], ["b", 2], ["c", 3]] as const) w.intent("p", id, seq);
        const cursor: Cursor = {};
        for (let i = 0; i < 2; i++) {
          expect([budgetMs, await w.pass(passPace(cursor, { budgetMs, now: Number.isNaN(budgetMs) ? lateClock() : still }).phase())])
            .toEqual([budgetMs, ["a", "b", "c"]]);
          // before: cursor.merge kept c's key, so the next pass started after c
          expect(cursor.merge).toBeUndefined();
        }
      } finally { w.close(); }
    }
  });

  test("[验收线 1] a zero budget starts no intent and keeps the cursor", async () => {
    const w = mergeWorld(["p"]);
    try {
      w.intent("p", "a", 1); w.intent("p", "b", 2);
      const cursor: Cursor = {};
      await w.pass(cut(cursor));
      const mark = cursor.merge;
      expect(await w.pass(passPace(cursor, { budgetMs: 0, now: still }).phase())).toEqual([]);
      expect(cursor.merge).toBe(mark);
    } finally { w.close(); }
  });

  test("[验收线 1] a cut-off keeps the last started intent; the next pass goes on after it; a full pass clears, then config order again", async () => {
    const w = mergeWorld(["p"]);
    try {
      for (const [id, seq] of [["a", 1], ["b", 2], ["c", 3]] as const) w.intent("p", id, seq);
      const cursor: Cursor = {};
      expect(await w.pass(cut(cursor))).toEqual(["a"]);
      expect(cursor.merge).toBeDefined();
      expect(await w.pass(cut(cursor))).toEqual(["b"]);
      expect(await w.pass(ample(cursor))).toEqual(["c", "a", "b"]); // from after the cut-off, round once
      expect(cursor.merge).toBeUndefined();
      expect(await w.pass(ample(cursor))).toEqual(["a", "b", "c"]);
    } finally { w.close(); }
  });

  test("[验收线 1] a throw (SchedulerStopped), an update, an outside pace: the cursor is what the pass found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mtrbud2-req-")), request = join(dir, "m.req");
    try {
      for (const exit of ["stopped", "update", "outside"] as const) {
        for (const marked of [false, true]) {
          const w = mergeWorld(["p"]);
          try {
            for (const [id, seq] of [["a", 1], ["b", 2], ["c", 3]] as const) w.intent("p", id, seq);
            const cursor: Cursor = {};
            if (marked) expect(await w.pass(cut(cursor))).toEqual(["a"]);
            const found = cursor.merge;
            if (exit === "stopped") {
              w.stopAt(marked ? "b" : "a");
              await expect(w.pass(ample(cursor))).rejects.toBeInstanceOf(SchedulerStopped);
            } else if (exit === "update") {
              w.afterClaim(() => writeFileSync(request, "1"));
              expect((await w.pass(passPace(cursor, { budgetMs: 60_000, request, now: Date.now }).phase())).length).toBe(1);
              rmSync(request, { force: true });
            } else expect((await w.pass(outside(cursor, 1))).length).toBe(1);
            // before: the key of the intent started in this pass
            expect([exit, marked, cursor.merge]).toEqual([exit, marked, found]);
          } finally { w.close(); }
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("MTRBUD2 merge order across projects: scheduler.json's order, then eventSeq", () => {
  const twoProjects = () => {
    const w = mergeWorld(["q", "p"]);
    w.intent("p", "p1", 1); w.intent("q", "q1", 2); w.intent("p", "p2", 3); w.intent("q", "q2", 4);
    return w;
  };

  test("[验收线 3] old red: q before p with an empty cursor and a 60s budget", async () => {
    const w = twoProjects();
    try {
      const cursor: Cursor = {};
      // before: p1, p2, q1, q2 (projects sorted by name)
      expect(await w.pass(ample(cursor))).toEqual(["q1", "q2", "p1", "p2"]);
      expect(await w.pass(ample(cursor))).toEqual(["q1", "q2", "p1", "p2"]);
    } finally { w.close(); }
  });

  test("[验收线 3] cut-offs go round from the cut-off point in q → p order; every intent gets its turn", async () => {
    const w = twoProjects();
    try {
      const cursor: Cursor = {}, seen: string[] = [];
      for (let i = 0; i < 6; i++) seen.push(...await w.pass(cut(cursor)));
      expect(seen).toEqual(["q1", "q2", "p1", "p2", "q1", "q2"]);
      expect(await w.pass(ample(cursor))).toEqual(["p1", "p2", "q1", "q2"]);
      expect(cursor.merge).toBeUndefined();
    } finally { w.close(); }
  });
});

/** Running deploy rows d1..dn (createdAt in order), each a deploy card whose job `view` decides; `observed` lists the cards started. */
function deployWorld(n: number) {
  const dir = mkdtempSync(join(tmpdir(), "mtrbud2-d-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const config = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: "/tmp/p" } } });
  for (let i = 1; i <= n; i++) {
    createTask(db, { actor: "owner", now: 100 }, { project: "p", id: `T${i}`, title: `T${i}`, kind: "code" });
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,'p','merge_deploy','merge',1,?,1,1,?,2,'submitted','seed',100,100)`).run(`d${i}`, `T${i}`, i, "c".repeat(40));
    db.query(`INSERT INTO scheduler_deploys (intentId,taskId,project,prRef,mergeSha,phase,label,createdAt,updatedAt)
      VALUES (?,?,'p','pr',?,'running','job',?,?)`).run(`d${i}`, `T${i}`, "e".repeat(40), 100 + i, 100 + i);
  }
  const observed: string[] = [];
  const s = { view: (_id: string): Awaited<ReturnType<DeployJobs["observe"]>> => ({ label: "job", liveness: "alive", result: null, deadline: 10_000 }),
    lost: false, after: null as (() => void) | null };
  const jobs: DeployJobs = { label: () => "job", submit: async () => "job", remove: async () => true,
    observe: async (run) => { observed.push(run.intentId); s.after?.(); return s.view(run.intentId); } };
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    throw new SchedulerStopped(`服务停止：${args[1]}`);
  };
  const assertActive = () => { if (s.lost) throw new SchedulerStopped("失去维护租约"); };
  const pass = async (pace?: TickPace) => {
    const before = observed.length;
    await deployTick(db, config, { manager, jobs, assertActive, now: () => 1_000 }, pace);
    return observed.slice(before);
  };
  return { s, pass, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

describe("MTRBUD2 deploy cursor: a stop, an update or an outside pace leaves it as the tick found it", () => {
  test("[验收线 2] old red: the first manager call throws SchedulerStopped, or the lease is lost mid-card", async () => {
    for (const how of ["manager", "lease"] as const) {
      for (const marked of [false, true]) {
        const w = deployWorld(3);
        try {
          const cursor: Cursor = {};
          if (marked) expect(await w.pass(cut(cursor))).toEqual(["d1"]);
          const found = cursor.deploy;
          if (how === "manager") w.s.view = () => ({ label: "job", liveness: "dead", result: { ok: true, summary: "完成" }, deadline: 10_000 });
          else { w.s.view = () => ({ label: "job", liveness: "alive", result: null, deadline: 0 }); w.s.lost = true; } // past its deadline: assertActive first
          await expect(w.pass(ample(cursor))).rejects.toBeInstanceOf(SchedulerStopped);
          // before: the key of the card that threw
          expect([how, marked, cursor.deploy]).toEqual([how, marked, found]);
        } finally { w.close(); }
      }
    }
  });

  test("[验收线 2] old red: an update midway or an outside pace yielding after a card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mtrbud2-req-")), request = join(dir, "m.req");
    try {
      for (const exit of ["update", "outside"] as const) {
        for (const marked of [false, true]) {
          const w = deployWorld(3);
          try {
            const cursor: Cursor = {};
            if (marked) expect(await w.pass(cut(cursor))).toEqual(["d1"]);
            const found = cursor.deploy;
            if (exit === "update") {
              w.s.after = () => writeFileSync(request, "1");
              expect((await w.pass(passPace(cursor, { budgetMs: 60_000, request, now: Date.now }).phase())).length).toBe(1);
              rmSync(request, { force: true });
            } else expect((await w.pass(outside(cursor, 1))).length).toBe(1);
            expect([exit, marked, cursor.deploy]).toEqual([exit, marked, found]);
          } finally { w.close(); }
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("[验收线 2] a cut-off and a full tick behave as before", async () => {
    const w = deployWorld(3);
    try {
      const cursor: Cursor = {};
      expect(await w.pass(cut(cursor))).toEqual(["d1"]);
      expect(cursor.deploy).toBeDefined();
      expect(await w.pass(cut(cursor))).toEqual(["d2"]);
      expect(await w.pass(ample(cursor))).toEqual(["d3", "d1", "d2"]);
      expect(cursor.deploy).toBeUndefined();
      expect(await w.pass(ample(cursor))).toEqual(["d1", "d2", "d3"]);
    } finally { w.close(); }
  });
});

const STAGES = ["spec", "restate", "build", "review", "merge"];
/** M1 is at merge with an unknown merge intent: held every pass, and mergeFirst walks it first (as in the fair test). */
function unknownMergeM1(f: ReturnType<typeof autoFixture>) {
  createTask(f.db, f.at("owner"), { project: "p", id: "M1", title: "M1", kind: "code" });
  setWorkflow(f.db, f.at("owner"), { taskId: "M1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  for (let i = 1; i < STAGES.length; i++) moveStage(f.db, f.at("owner"), { taskId: "M1", from: STAGES[i - 1] as never, to: STAGES[i] as never });
  f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,receipt,createdAt,updatedAt)
    VALUES ('mm1','M1','p','merge','merge',1,1,1,1,?,2,'unknown','seed','外部结果不明',300,300)`).run("c".repeat(40));
}

describe("MTRBUD2 auto order contract (locked as it is, not an old red)", () => {
  let saved: Buffer | null = null;
  beforeEach(() => { saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null; rmSync(RECOVERY_POLICY_PATH, { force: true }); });
  afterEach(() => { if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved); else rmSync(RECOVERY_POLICY_PATH, { force: true }); });
  const tick = (f: ReturnType<typeof autoFixture>, pace: TickPace) => schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps, pace);

  test("[验收线 4] nothing owed: mergeFirst order every pass, autoBudget never set", async () => {
    const f = autoFixture();
    try {
      unknownMergeM1(f);
      const cursor: Cursor = {};
      for (let i = 0; i < 3; i++) {
        const r = await tick(f, ample(cursor));
        expect([r.failed, r.cards.map((c) => c.taskId), cursor.autoBudget]).toEqual([[], ["M1", "T1"], undefined]);
      }
    } finally { f.close(); }
  });

  test("[验收线 4] He's case: an owed p/M1 puts T1 first once, is cleared, and the next pass is back to M1 first", async () => {
    const f = autoFixture();
    try {
      unknownMergeM1(f);
      const cursor: Cursor = { auto: "p/M1", autoBudget: "p/M1" };
      const first = await tick(f, ample(cursor));
      expect([first.failed, first.cards.map((c) => c.taskId), cursor.autoBudget]).toEqual([[], ["T1", "M1"], undefined]);
      const next = await tick(f, ample(cursor));
      expect([next.cards.map((c) => c.taskId), cursor.autoBudget]).toEqual([["M1", "T1"], undefined]);
    } finally { f.close(); }
  });

  test("[验收线 4] an invalid budget or an outside pace that yields owes nothing", async () => {
    for (const pace of [(c: Cursor) => passPace(c, { budgetMs: 0, now: still }).phase(), (c: Cursor) => passPace(c, { budgetMs: -5, now: still }).phase(),
      (c: Cursor) => passPace(c, { budgetMs: Number.NaN, now: lateClock() }).phase(), (c: Cursor) => outside(c, 1)]) {
      const f = autoFixture();
      try {
        unknownMergeM1(f);
        const cursor: Cursor = {};
        await tick(f, pace(cursor));
        expect(cursor.autoBudget).toBeUndefined();
      } finally { f.close(); }
    }
  });
});
