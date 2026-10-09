import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { autoResumeTick, resumeVerdict } from "../src/lib/scheduler-autostart-resume.js";
import { createTask } from "../src/lib/ledger-write.js";
import { schedulerPass, type PassOpts } from "../src/lib/scheduler-pass.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { configureSchedulerV2Pass, schedulerV2PassManager, schedulerV2Route,
  type SchedulerV2FeatureMode, type SchedulerV2Switch } from "../src/lib/scheduler-v2-pass.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";
import { autoSource, pendingAutoEvents, sourceKey } from "../src/lib/memory-auto-common.js";

const modes = ["source", "planning", "execution"] as const;
const switches: SchedulerV2Switch[] = ["off", "observe", "on"];
const cleanups: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Pass(null); while (cleanups.length) cleanups.pop()!(); });

function writeMode(dir: string, db: Database, taskId: string, mode: SchedulerV2FeatureMode) {
  db.query("INSERT OR IGNORE INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f','p','synthetic','active','owner',1,1)").run();
  db.query("UPDATE tasks SET featureId='f' WHERE id=?").run(taskId);
  writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { f: mode } }));
}
function config(dir: string, deploy = false): SchedulerConfig {
  return { enabled: true, autoDispatch: false, pollMs: 1000, projects: {
    p: { repoDir: dir, maxActiveWorkers: 2, requiredChecks: ["ci"], mergeTrain: "off",
      ...(deploy ? { deploy: { restartLabels: ["fake"], timeoutMs: 60_000 } } : {}) },
  } };
}
function passOpts(dir: string): PassOpts {
  return { assertOwner: () => {}, maintenance: { path: join(dir, "maintenance"), marker: join(dir, "marker"), request: join(dir, "request") },
    trainTick: async () => {}, peerPr: async () => ({ failed: [] }),
    autostart: () => ({ start: async () => [], resume: async () => [] }),
    lockYield: async () => [], retire: async () => [], lifecycle: async () => [] };
}
const events = (db: Database) => db.query("SELECT * FROM events ORDER BY seq").all();
function consumeMemoryBacklog(db: Database) {
  // Seed already-consumed project decisions so the unrelated memory sweep has no work in a routing test.
  for (const e of pendingAutoEvents(db, "p", 100)) {
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1,'scheduler','p',?,'memory','','{}',?)")
      .run(e.target, `memory-auto:p:${sourceKey(autoSource(e))}`);
  }
}

describe("stage2 pass routing", () => {
  test("all 36 mode/switch/migrating/port combinations obey freeze-first routing", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2d-route-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
    createTask(db, { actor: "owner" }, { id: "T", project: "p", title: "synthetic", kind: "code" });
    const logs = spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const authorityMode of modes) for (const mode of switches) for (const migrating of [false, true]) for (const connected of [false, true]) {
        writeMode(dir, db, "T", { authorityMode, sharedPlanning: authorityMode !== "source",
          ...(migrating ? { migrating: { batchId: "batch", kind: "execute" } as const } : {}) });
        let reads = 0;
        configureSchedulerV2Pass(connected ? { mode: () => { reads++; return mode; }, wrapManager: (m) => m } : null);
        const expected = migrating ? "skip" : authorityMode !== "execution" ? "local" : connected && mode === "on" ? "central" : "skip";
        expect(schedulerV2Route("T", db)).toBe(expected);
        expect(reads).toBe(connected && !migrating && authorityMode === "execution" ? 1 : 0);
      }
    } finally { logs.mockRestore(); }
  });

  test("one-argument route with no configuration reads only the isolated local mode and holds execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s2d-local-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
    createTask(db, { actor: "owner" }, { id: "T", project: "p", title: "synthetic", kind: "code" });
    writeMode(dir, db, "T", { authorityMode: "execution", sharedPlanning: true });
    const child = Bun.spawn([process.execPath, "-e",
      'import { schedulerV2Route } from "./src/lib/scheduler-v2-pass.ts"; console.log(schedulerV2Route("T"));'],
      { cwd: process.cwd(), env: { ...process.env, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime") },
        stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().endsWith("skip")).toBe(true);
    expect(stdout).toContain("unavailable");
  });

  for (const [authorityMode, kind] of [["planning", "execute"], ["execution", "home"]] as const) {
    test(`real pass: ${authorityMode}+migrating ${kind}+on makes no order, event or intent-port call`, async () => {
      const f = autoFixture(); cleanups.push(f.close);
      await toBuild(f);
      consumeMemoryBacklog(f.db);
      writeMode(f.dir, f.db, "T1", { authorityMode, sharedPlanning: true, migrating: { batchId: "batch", kind } });
      let intentPort = 0, managerCalls = 0;
      configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
      const before = events(f.db), sent = f.sent.length;
      const result = await schedulerPass(f.db, { ...config(f.dir), autoDispatch: true }, { ...passOpts(f.dir),
        manager: async () => { managerCalls++; throw new Error("frozen manager"); },
        autoDeps: () => ({ ...f.tickDeps, ensure: async (...args) => { intentPort++; return f.tickDeps.ensure(...args); },
          manager: async (...args) => { intentPort++; return f.tickDeps.manager(...args); } }),
      });
      expect(result).toEqual({ ran: true, failed: [] });
      expect(events(f.db)).toEqual(before);
      expect(f.sent).toHaveLength(sent);
      expect([intentPort, managerCalls]).toEqual([0, 0]);
    });
  }

  async function drive(authorityMode: "source" | "execution", mode: SchedulerV2Switch, connected = true) {
    const f = autoFixture(); cleanups.push(f.close);
    await toBuild(f);
    consumeMemoryBacklog(f.db);
    writeMode(f.dir, f.db, "T1", { authorityMode, sharedPlanning: false });
    let centerCalls = 0;
    configureSchedulerV2Pass(connected ? { mode: () => mode, wrapManager: (m) => m } : null);
    const before = events(f.db), beforeSent = f.sent.length, registry = readFileSync(f.registryPath, "utf8");
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const result = await schedulerPass(f.db, { ...config(f.dir), autoDispatch: true }, { ...passOpts(f.dir), manager: f.tickDeps.manager,
        autoDeps: () => ({ ...f.tickDeps, borrow: async () => { centerCalls++; return []; } }),
      });
      expect(result.failed).toEqual([]);
      expect(centerCalls).toBe(0);
      expect(readFileSync(f.registryPath, "utf8")).toBe(registry);
      return { eventDelta: events(f.db).slice(before.length).map((r: any) => ({ ...r, ts: 0, data: JSON.parse(r.data) })),
        orders: f.sent.slice(beforeSent).map((s) => ({ ...s, text: s.text.replaceAll(f.dir, "<tmp>") })),
        pins: f.pins, logs: info.mock.calls.flat().join("\n") };
    } finally { info.mockRestore(); }
  }

  test("off and observe execution stop identically, observe logs its decision, null is unavailable", async () => {
    const off = await drive("execution", "off"), observe = await drive("execution", "observe"), unavailable = await drive("execution", "on", false);
    for (const run of [off, observe, unavailable]) { expect(run.eventDelta).toEqual([]); expect(run.orders).toEqual([]); expect(run.pins).toEqual([]); }
    expect(observe.logs).toContain("observe");
    expect(unavailable.logs).toContain("unavailable");
  });

  test("spec placement and observe workflow also stop before any ledger write", async () => {
    for (const workflow of ["auto", "observe"]) {
      const f = autoFixture(); cleanups.push(f.close);
      f.db.query("UPDATE task_workflows SET mode=?").run(workflow);
      writeMode(f.dir, f.db, "T1", { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "batch", kind: "execute" } });
      configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
      const before = events(f.db);
      expect(await schedulerPass(f.db, { ...config(f.dir), autoDispatch: true }, { ...passOpts(f.dir),
        manager: async () => { throw new Error("frozen writer"); }, autoDeps: () => f.tickDeps,
      })).toEqual({ ran: true, failed: [] });
      expect(events(f.db)).toEqual(before);
      expect(f.sent).toEqual([]);
      expect(f.ensured).toEqual([]);
    }
  });

  test("merge/deploy migrating candidates never reach manager, GitHub or job ports", async () => {
    const f = mergedCard(); cleanups.push(f.close);
    writeMode(f.dir, f.db, "T9", { authorityMode: "execution", sharedPlanning: true, migrating: { batchId: "batch", kind: "home" } });
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
    const before = events(f.db);
    const forbidden = async (): Promise<never> => { throw new Error("frozen effect"); };
    expect(await schedulerPass(f.db, config(f.dir, true), { ...passOpts(f.dir), manager: forbidden,
      external: () => { throw new Error("frozen GitHub factory"); },
      deployJobs: { observe: forbidden, label: () => { throw new Error("frozen label"); }, submit: forbidden, remove: forbidden },
    })).toEqual({ ran: true, failed: [] });
    expect(events(f.db)).toEqual(before);
  });

  test("real pass holds an otherwise eligible manual/review automatic resume while migrating", async () => {
    const f = mergedCard(); cleanups.push(f.close);
    const head = "e".repeat(40);
    f.db.query("UPDATE scheduler_intents SET status='done' WHERE id=?").run(f.intent);
    f.db.query("UPDATE task_workflows SET mode='manual'").run();
    f.db.query("UPDATE tasks SET stage='review',headSHA=? WHERE id='T9'").run(head);
    const append = (actor: string, kind: string, data: object) =>
      f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,?,'p','T9',?,'',?)").run(actor, kind, JSON.stringify(data));
    append("owner", "scheduler", { op: "merge_resolve", outcome: "cancelled", intentId: f.intent });
    append("agent-author", "stage", { from: "fix", to: "review" });
    append("agent-author", "deliver", { headSHA: head });
    expect(resumeVerdict(f.db, getTask(f.db, "T9")!, getWorkflow(f.db, "T9"))).toMatchObject({ ok: true });
    writeMode(f.dir, f.db, "T9", { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "batch", kind: "execute" } });
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
    const before = events(f.db), calls: string[][] = [];
    const ledger = async (...args: string[]) => { calls.push(args); return { ok: true }; };
    const env = { db: f.db, svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 2 },
      ledger, memo: new Set<string>(), notifyPm: async () => { throw new Error("frozen notice"); } };
    expect(await schedulerPass(f.db, { ...config(f.dir), autoDispatch: true }, { ...passOpts(f.dir), manager: ledger,
      autoDeps: () => ({} as ReturnType<typeof autoFixture>["tickDeps"]),
      autostart: () => ({ start: async () => [], resume: (_config, pace) => autoResumeTick(env, pace) }),
    })).toEqual({ ran: true, failed: [] });
    expect(calls).toEqual([]);
    expect(events(f.db)).toEqual(before);
    await autoResumeTick(env); // Without the optional route hook the seeded candidate reaches the old writer.
    expect(calls.map((c) => c[1])).toEqual(["scheduler-auto-resume"]);
  });

  test("non execution has identical off/observe/on events, orders and worktree actions", async () => {
    const off = await drive("source", "off"), observe = await drive("source", "observe"), on = await drive("source", "on");
    expect(observe.eventDelta).toEqual(off.eventDelta);
    expect(on.eventDelta).toEqual(off.eventDelta);
    expect(observe.orders).toEqual(off.orders);
    expect(on.orders).toEqual(off.orders);
    expect(observe.pins).toEqual(off.pins);
    expect(on.pins).toEqual(off.pins);
  });
});

describe("pass manager wiring", () => {
  test("null preserves manager identity; configured wrapper gets the exact input", () => {
    const manager = async () => ({ ok: true });
    expect(schedulerV2PassManager(manager)).toBe(manager);
    const wrapped = async () => ({ ok: false });
    configureSchedulerV2Pass({ mode: () => "off", wrapManager: (m) => { expect(m).toBe(manager); return wrapped; } });
    expect(schedulerV2PassManager(manager)).toBe(wrapped);
  });

  test("real merge claims and begins through spy before external; retire gets the wrapped manager", async () => {
    const f = mergedCard(); cleanups.push(f.close);
    f.db.query("UPDATE scheduler_intents SET status='done' WHERE id=?").run(f.intent);
    f.db.query(`INSERT INTO scheduler_intents
      (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      SELECT 'new-merge',taskId,project,node,action,causalSeq,99,taskRev,specRev,head,templateVersion,'pending',reason,createdAt,updatedAt
      FROM scheduler_intents WHERE id=?`).run(f.intent);
    f.db.query("UPDATE scheduler_resources SET intentId='new-merge' WHERE intentId=?").run(f.intent);
    const log: string[] = [], ledger = ledgerAs(f.db, "scheduler");
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => async (...args) => { log.push(args[1]); return m(...args); } });
    await schedulerPass(f.db, config(f.dir), { ...passOpts(f.dir), manager: ledger,
      external: () => { log.push("external"); return {
        inspect: async () => ({ state: "OPEN", head: "c".repeat(40), branch: "feat/t9", crossRepository: false, base: "main",
          draft: true, mergeState: "UNKNOWN", mergeSha: null, checks: [] }),
        freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }), carryReview: async () => ({ ok: false, reason: "unused" }),
        updateBranch: async () => { throw new Error("unused"); }, merge: async () => { throw new Error("unused"); },
      }; },
      retire: async (_db, _config, m) => { await m("probe", "retire"); return []; },
    });
    expect(log.slice(0, 3)).toEqual(["scheduler-settle", "scheduler-merge-begin", "external"]);
    expect(log).toContain("retire");
  });

  test("real deploy uses wrapped manager", async () => {
    const f = mergedCard(); cleanups.push(f.close);
    const log: string[] = [];
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => async (...args) => { log.push(args[1]); return m(...args); } });
    await schedulerPass(f.db, config(f.dir, true), { ...passOpts(f.dir), manager: ledgerAs(f.db, "scheduler"),
      deployJobs: { observe: async () => null, label: () => `com.claudestra.scheduler.deploy.${"f".repeat(32)}`,
        submit: async () => "fake", remove: async () => true },
    });
    expect(log).toContain("scheduler-deploy-begin");
    expect(log).toContain("scheduler-deploy-step");
  });

  test("maintenance guard blocks even an intercepted manager call after owner loss", async () => {
    const f = mergedCard(); cleanups.push(f.close);
    let alive = true, intercepted = 0;
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: () => async () => { intercepted++; return { ok: true }; } });
    await expect(schedulerPass(f.db, { ...config(f.dir), projects: {} }, { ...passOpts(f.dir),
      assertOwner: () => { if (!alive) throw new SchedulerStopped("lost"); },
      retire: async (_db, _config, manager) => { alive = false; await manager("probe"); return []; },
    })).rejects.toBeInstanceOf(SchedulerStopped);
    expect(intercepted).toBe(0);
  });
});
