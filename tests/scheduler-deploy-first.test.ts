import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { deployYield, passClock, submittedSince } from "../src/lib/scheduler-deploy-first.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { requestMaintenance } from "../src/lib/scheduler-yield.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "deploy-first-")); dirs.push(d); return d; };

const policyOf = (modes: Record<string, RecoveryMode>): RecoveryPolicyPort => (project, key) =>
  ({ mode: key === "deployFirst" ? modes[project] ?? "observe" : "off", manualAfterMs: null, source: "config" });

function deploysDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE scheduler_deploys (intentId TEXT PRIMARY KEY, phase TEXT NOT NULL, createdAt INTEGER NOT NULL)");
  return db;
}
const addDeploy = (db: Database, id: string, phase: string, createdAt: number) =>
  db.run("INSERT INTO scheduler_deploys (intentId, phase, createdAt) VALUES (?, ?, ?)", [id, phase, createdAt]);

describe("deployYield: what counts as a waiting deploy", () => {
  test("only a claimed or running deploy created since the pass began; no table or no db is none", () => {
    const db = deploysDb();
    addDeploy(db, "old", "running", 900);
    addDeploy(db, "done", "deployed", 1_500);
    expect(submittedSince(db, 1_000)).toBe(false);
    addDeploy(db, "new", "claimed", 1_200);
    expect(submittedSince(db, 1_000)).toBe(true);
    expect(submittedSince(new Database(":memory:"), 0)).toBe(false);
    expect(submittedSince(null, 0)).toBe(false);
  });

  test("off never stops and notes nothing; observe notes but never stops; on stops from the first sighting on", () => {
    let t = 10_000;
    const now = () => t;
    for (const [mode, stops] of [["off", false], ["observe", false], ["on", true]] as const) {
      const db = deploysDb(), y = deployYield(db, 10_000, ["p"], policyOf({ p: mode }), join(tmp(), "req"), now);
      expect(y.mode).toBe(mode);
      expect(y.stop()).toBe(false);
      expect(y.note()).toBeNull();
      t = 13_000;
      addDeploy(db, "d", "running", 12_000);
      expect(y.stop()).toBe(stops);
      db.run("UPDATE scheduler_deploys SET phase = 'deployed'"); // once seen it stays seen: no flapping within a pass
      t = 20_000;
      expect(y.stop()).toBe(stops);
      const note = y.note();
      if (mode === "off") expect(note).toBeNull();
      else if (mode === "observe") expect(note).toBe("observe：部署 / 更新第 3s 起在等锁，之后的步骤又跑了 7s（on 时这段留给下一轮）");
      else expect(note).toBe("部署 / 更新在等锁，本轮第 3s 起没再开新步骤");
      t = 10_000;
    }
  });

  test("a fresh maintenance request counts like a deploy; the strongest mode among the pass's projects applies", () => {
    const req = join(tmp(), "req"), db = deploysDb();
    const y = deployYield(db, Date.now(), ["a", "b"], policyOf({ a: "off", b: "on" }), req);
    expect(y.mode).toBe("on");
    expect(y.stop()).toBe(false);
    requestMaintenance(req);
    expect(y.stop()).toBe(true);
    expect(deployYield(db, 0, [], policyOf({}), req).mode).toBe("off");
  });
});

describe("passClock", () => {
  test("lists steps of half a second or more in order, with the total and the deploy note", () => {
    let t = 0;
    const c = passClock(() => t);
    t = 300; c.mark("merge");
    t = 2_300; c.mark("supervise");
    t = 2_400; c.mark("retire");
    t = 9_000; c.mark("lifecycle");
    expect(c.line(null)).toBe("[pass] 9s：supervise 2.0 / lifecycle 6.6");
    expect(passClock(() => 0).line("x")).toBe("[pass] 0s：每步都不到 0.5s；x");
  });
});

describe("the pass with a deploy submitted mid-pass", () => {
  async function pass(mode: RecoveryMode, during: (db: Database, req: string) => void, before?: (db: Database) => void) {
    const dir = tmp(), path = join(dir, "ledger.sqlite"), req = join(dir, "maint.request");
    const db = openLedger(path);
    db.run("PRAGMA foreign_keys = OFF");
    before?.(db);
    const calls: string[] = [], lines: string[] = [];
    const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: dir } } });
    try {
      const r = await schedulerPass(db, config, {
        assertOwner: () => {}, maintenance: { path: join(dir, "maint.lock"), marker: join(dir, "update.marker"), request: req },
        recoveryPolicy: policyOf({ p: mode }), log: (l) => lines.push(l),
        trainTick: async (d) => { calls.push("train"); during(d, req); },
        retire: async () => { calls.push("retire"); return []; },
        lifecycle: async () => { calls.push("lifecycle"); return []; },
      });
      return { r, calls, lines };
    } finally { closeLedger(path); }
  }
  const submit = (db: Database) => db.run(`INSERT INTO scheduler_deploys (intentId, taskId, project, prRef, mergeSha, phase, createdAt, updatedAt)
    VALUES ('i1', 'T1', 'p', 'pr', 'sha', 'running', ?, ?)`, [Date.now(), Date.now()]);

  test("on: no step after the submission starts; the pass still counts as run and logs why it stopped", async () => {
    const { r, calls, lines } = await pass("on", submit);
    expect(r).toEqual({ ran: true, failed: [] });
    expect(calls).toEqual(["train"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[pass\] \d+s：.*；部署 \/ 更新在等锁，本轮第 \d+s 起没再开新步骤$/);
  });

  test("on: a maintenance request that shows up mid-pass stops it the same way", async () => {
    const { calls } = await pass("on", (_db, req) => requestMaintenance(req));
    expect(calls).toEqual(["train"]);
  });

  test("observe runs every step and logs what on would have saved; off logs only the timings", async () => {
    const seen = await pass("observe", submit);
    expect(seen.calls).toEqual(["train", "retire", "lifecycle"]);
    expect(seen.lines[0]).toContain("；observe：部署 / 更新第");
    const off = await pass("off", submit);
    expect(off.calls).toEqual(["train", "retire", "lifecycle"]);
    expect(off.lines[0]).not.toContain("；");
  });

  test("on: a deploy still in flight from before the pass is not this pass's, so nothing is cut", async () => {
    const old = (db: Database) => db.run(`INSERT INTO scheduler_deploys (intentId, taskId, project, prRef, mergeSha, phase, createdAt, updatedAt)
      VALUES ('i0', 'T0', 'p', 'pr', 'sha', 'running', 1, 1)`);
    const { calls, lines } = await pass("on", () => {}, old);
    expect(calls).toEqual(["train", "retire", "lifecycle"]);
    expect(lines[0]).not.toContain("；");
  });
});
