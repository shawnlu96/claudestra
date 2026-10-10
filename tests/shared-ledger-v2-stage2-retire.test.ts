import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { beginRetire, recordSessionRetirement } from "../src/lib/scheduler-sessions.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { schedulerRetireTick, type RetireDeps } from "../src/lib/scheduler-retire.js";

import { configureSchedulerV2Retire, withSchedulerV2Retire, V2Held, V2LeaseLost, type ExecFeatureRef, type SchedulerV2RetirePort } from "../src/lib/scheduler-v2-retire.js";
import type { V2Fence } from "../src/lib/shared-ledger-contract-v2-validation.js";
import { claudeTmpDirFor } from "../src/lib/scheduler-retire-tmp.js";
import { worktreeDirs } from "../src/lib/scheduler-retire.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";

const ctx = { actor: "scheduler", now: 100 };
const cleanup: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Retire(null); while (cleanup.length) cleanup.pop()!(); });

function fixture(memory = true) {
  const dir = mkdtempSync(join(tmpdir(), "s2v-retire-")), path = memory ? ":memory:" : join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const root = join(dir, "worktrees"), tmp = join(dir, "tmp");
  mkdirSync(tmp);
  for (const checkout of worktreeDirs(root, "A")) mkdirSync(claudeTmpDirFor(checkout, tmp));
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "A", title: "A", kind: "code" });
  db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'A'").run();
  db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('ensure:A','A','p','write','ensure_session',0,1,1,2,'done','test',0,0)`).run();
  db.query(`INSERT INTO scheduler_sessions
    (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('A','author','worker-A','session-A','claude','tmux','active','ensure:A',0,0)`).run();
  const effects: string[] = [];
  let stopped = false;
  let duringAgents = () => {};
  const deps: RetireDeps = {
    ledger: async (...a) => {
      if (a[1] === "scheduler-retire") return { ok: true, ...beginRetire(db, ctx, a[2]) };
      if (a[1] === "scheduler-session-retire") {
        recordSessionRetirement(db, ctx, { taskId: a[2], role: "author", intentId: a[6], effect: a[8] as "archive" | "kill", receipt: a[10] });
        return { ok: true };
      }
      settleIntent(db, ctx, { id: a[2], from: "submitted", to: "done", receipt: "test" });
      return { ok: true };
    },
    agent: async (op) => { effects.push(op); if (op === "kill") stopped = true; return { ok: true }; },
    agents: async () => { duringAgents(); return [{ name: "worker-A", sessionId: "session-A", status: stopped ? "stopped" : "running",
      pending: false, window: !stopped }]; },
    git: async (a) => { effects.push(`git:${a[2]}`); return { code: 0, out: a[2] === "rev-parse" ? "/repo/.git/worktrees/a\n/repo/.git\n" : "" }; },
    exists: () => true, worktreeRoot: root, notifyPm: async () => {},
    tmp: { root: tmp, rm: async () => { effects.push("tmp"); } },
  };
  return { db, dir, deps, effects, change: (fn: () => void) => { duringAgents = fn; } };
}

test("regression control: unwrapped retirement kills after the read callback loses the lease", async () => {
  const f = fixture();
  let fence: unknown = {};
  f.change(() => { fence = null; });
  await schedulerRetireTick(f.db, ["p"], f.deps);
  expect(fence).toBeNull();
  expect(f.effects).toContain("kill");
});

const term: V2Fence = { serviceGeneration: 1, epoch: 1, bootId: "boot-1" };
function portFixture() {
  let route: "local" | "central" | "skip" = "central", fence: V2Fence | null = term, claim: V2Fence | null = term;
  const seen: string[] = [];
  const feature: ExecFeatureRef = { localFeatureId: "local-feature", projectId: "p", centerFeatureId: "center-feature", epoch: 1 };
  const port: SchedulerV2RetirePort = {
    route: () => route,
    featureOfTask: () => feature,
    fence: (id) => { seen.push(id); return fence; }, claimFence: () => claim,
  };
  configureSchedulerV2Retire(port);
  return { port, seen, route: (v: typeof route) => { route = v; }, fence: (v: typeof fence) => { fence = v; },
    claim: (v: typeof claim) => { claim = v; } };
}

for (const next of [null, { ...term, epoch: 2 }, { ...term, bootId: "boot-2" }, { ...term, serviceGeneration: 2 }]) {
  test(`read callback loses/replaces fence ${JSON.stringify(next)}: only archive is emitted`, async () => {
    const f = fixture(), p = portFixture();
    f.change(() => p.fence(next));
    const r = await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
    expect(r.failed).toEqual([{ taskId: "A", error: "V2LeaseLost: A retirement claim is not the current term" }]);
    expect(f.effects).toEqual(["archive"]);
    expect(f.db.query("SELECT archiveReceipt,killReceipt FROM scheduler_sessions").get()).toEqual({ archiveReceipt: "已归档 0 个文件", killReceipt: null });
    expect(f.db.query("SELECT data FROM events WHERE json_extract(data,'$.op') = 'session_retire'").all()).toHaveLength(1);
    expect(p.seen).toEqual(["center-feature", "center-feature"]);
  });
}

for (const claim of [null, term]) {
  test(`old/missing claim rejects archive at tick start: ${JSON.stringify(claim)}`, async () => {
    const f = fixture(), p = portFixture();
    beginRetire(f.db, ctx, "A");
    p.fence({ ...term, epoch: 2 }); p.claim(claim);
    const r = await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
    expect(r.failed[0].error).toContain("V2LeaseLost"); expect(f.effects).toEqual([]);
  });
}

for (const reason of ["revoked", "off", "observe", "execution-migrating", "planning-migrating"]) {
  for (const fence of [null, term]) for (const duplicate of [false, true]) {
    test(`${reason}, fence=${!!fence}, duplicate=${duplicate}: route is recomputed after agents()`, async () => {
      const f = fixture(), p = portFixture();
      if (reason === "planning-migrating") p.route("local");
      if (duplicate) expect(beginRetire(f.db, ctx, "A").intent.status).toBe("submitted");
      f.change(() => { p.route("skip"); p.fence(fence); });
      const r = await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
      expect(r.failed[0].error).toContain("V2Held"); expect(f.effects).toEqual(["archive"]);
    });
  }
}

test("regression control: old skip passthrough still kills after revocation", async () => {
  const f = fixture(), p = portFixture();
  const oldRoute = p.port.route;
  p.port.route = (id) => oldRoute(id) === "skip" ? "local" : oldRoute(id);
  f.change(() => { p.route("skip"); p.fence(null); });
  await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
  expect(f.effects).toContain("kill");
});

for (const mode of ["central", "local", "null"] as const) {
  test(`${mode}: successful effects and durable business rows match unwrapped retirement`, async () => {
    const a = fixture(false), b = fixture(false), p = portFixture();
    const raw = await schedulerRetireTick(a.db, ["p"], a.deps);
    if (mode === "null") configureSchedulerV2Retire(null); else p.route(mode);
    const deps = withSchedulerV2Retire(b.db, b.deps);
    if (mode === "null") expect(deps).toBe(b.deps);
    const wrapped = await schedulerRetireTick(b.db, ["p"], deps);
    const normalized = (value: unknown, dir: string) => JSON.parse(JSON.stringify(value).replaceAll(basename(dir), "fixture"));
    expect(normalized(wrapped, b.dir)).toEqual(normalized(raw, a.dir)); expect(b.effects).toEqual(a.effects);
    expect(b.effects).toEqual(["archive", "kill", ...Array(2).fill(["git:rev-parse", "git:status", "git:worktree"]).flat(), "tmp", "tmp"]);
    for (const table of ["tasks", "events", "scheduler_sessions", "scheduler_intents", "scheduler_resources"]) {
      expect(normalized(b.db.query(`SELECT * FROM ${table}`).all(), b.dir)).toEqual(normalized(a.db.query(`SELECT * FROM ${table}`).all(), a.dir));
    }
  });
}

test("failed central card does not block another local card in the same tick", async () => {
  const f = fixture(), p = portFixture();
  createTask(f.db, { actor: "owner", now: 1 }, { project: "p", id: "Z", title: "Z", kind: "code" });
  f.db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'Z'").run();
  beginRetire(f.db, ctx, "Z");
  p.port.route = (id) => id === "A" ? "central" : "local";
  p.fence(null);
  const r = await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
  expect(r.failed.map((x) => x.taskId)).toEqual(["A"]);
  expect(r.cards.map((x) => [x.taskId, x.step])).toEqual([["Z", "retired"]]);
});

test("agent fallback checks the bound task and submitted claim; unknown agent passes through", async () => {
  const f = fixture(), p = portFixture();
  beginRetire(f.db, ctx, "A");
  const d = withSchedulerV2Retire(f.db, f.deps);
  p.route("skip");
  expect(() => d.agent("archive", "worker-A")).toThrow(V2Held);
  p.route("central"); p.fence(null);
  expect(() => d.agent("kill", "worker-A")).toThrow(V2LeaseLost);
  p.fence(term); await d.agent("archive", "worker-A");
  p.fence(null); await d.agent("archive", "unknown-worker");
  expect(f.effects).toEqual(["archive", "archive"]);
});

test("git and tmp check every emission synchronously; read ports retain identity", async () => {
  const f = fixture(), p = portFixture(), d = withSchedulerV2Retire(f.db, f.deps);
  expect(d.agents).toBe(f.deps.agents); expect(d.notifyPm).toBe(f.deps.notifyPm);
  await d.ledger("ledger", "scheduler-retire", "A");
  await d.git(["status"]); await d.tmp!.rm("fake");
  p.fence(null);
  expect(() => d.git(["worktree", "remove"])).toThrow(V2LeaseLost);
  expect(() => d.tmp!.rm("fake")).toThrow(V2LeaseLost);
  p.route("skip");
  expect(() => d.git(["status"])).toThrow(V2Held);
  expect(() => d.tmp!.rm("fake")).toThrow(V2Held);
  expect(f.effects).toEqual(["git:undefined", "tmp"]);
});

for (const execution of [false, true]) {
  test(`coexistence: off/observe match business rows and effects (execution=${execution})`, async () => {
    const snapshots: unknown[] = [], sequences: string[][] = [], logs: string[] = [];
    for (const mode of ["off", "observe"] as const) {
      const f = fixture(false), p = portFixture();
      p.port.route = (id) => { if (mode === "observe") logs.push(`${id}:${execution ? "skip" : "local"}`); return execution ? "skip" : "local"; };
      // Record the S2Q/write-gate decision at the ledger seam; those nodes are not in this clone yet.
      if (execution) f.deps.ledger = async () => ({ ok: false, code: "v2_held" });
      const r = await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(basename(f.dir), "fixture"));
      snapshots.push(normalize([r, f.db.query("SELECT * FROM events").all(), f.db.query("SELECT * FROM scheduler_sessions").all()]));
      sequences.push(f.effects);
    }
    expect(snapshots[0]).toEqual(snapshots[1]); expect(sequences[0]).toEqual(sequences[1]);
    if (execution) expect(sequences[0]).toEqual([]); else expect(logs).toContain("A:local");
  });
}

for (const mode of ["off", "observe", "on"] as const) {
  test(`${mode} + execution + unavailable injected ledger: no business write or external effect`, async () => {
    const f = fixture(), before = f.db.query("SELECT * FROM events").all();
    configureSchedulerV2Retire(null);
    const records: string[][] = [];
    f.deps.ledger = async (...args) => { records.push(args); return { ok: false, code: "unavailable", error: "unavailable" }; };
    const r = await schedulerRetireTick(f.db, ["p"], withSchedulerV2Retire(f.db, f.deps));
    expect(r.cards[0].detail).toContain("unavailable"); expect(f.effects).toEqual([]);
    expect(records).toEqual([["ledger", "scheduler-retire", "A"]]);
    expect(f.db.query("SELECT * FROM events").all()).toEqual(before);
  });
}

// S2V2: the tmp step must not swallow the term fence into an ordinary delete failure.
function tmpFixture(firstRm: (p: ReturnType<typeof portFixture>) => void) {
  const f = fixture(), p = portFixture(), rms: string[] = [], notices: string[] = [];
  f.deps.notifyPm = async (_task, text) => { notices.push(text); };
  f.deps.tmp = { root: f.deps.tmp!.root, rm: async (dir) => { rms.push(dir); if (rms.length === 1) firstRm(p); } };
  const intent = () => (f.db.query("SELECT status FROM scheduler_intents WHERE id = 'retire:A'").get() as { status: string } | null)?.status;
  return { f, p, rms, notices, intent };
}

for (const [name, firstRm, error] of [
  ["fence lost", (p: ReturnType<typeof portFixture>) => p.fence(null), "V2LeaseLost: A retirement claim is not the current term"],
  ["route revoked", (p: ReturnType<typeof portFixture>) => p.route("skip"), "V2Held: A retirement route is skip"],
] as const) {
  test(`${name} at the first tmp rm: card fails, second folder untouched, no PM notice, intent not settled`, async () => {
    const t = tmpFixture(firstRm);
    const r = await schedulerRetireTick(t.f.db, ["p"], withSchedulerV2Retire(t.f.db, t.f.deps));
    expect(r.failed).toEqual([{ taskId: "A", error }]);
    expect(r.cards).toEqual([]);
    expect(t.rms).toHaveLength(1);
    expect(t.notices).toEqual([]);
    expect(t.intent()).toBe("submitted");
  });
}

for (const code of ["EACCES", "ENOENT"]) {
  test(`ordinary tmp rm error ${code} is unchanged under the fence (EACCES: failed delete told to PM; ENOENT: deleted)`, async () => {
    const t = tmpFixture(() => {});
    const rm = t.f.deps.tmp!.rm;
    t.f.deps.tmp!.rm = async (dir) => { await rm(dir); throw Object.assign(new Error(`${code}: rm ${basename(dir)}`), { code }); };
    const r = await schedulerRetireTick(t.f.db, ["p"], withSchedulerV2Retire(t.f.db, t.f.deps));
    expect(r.failed).toEqual([]); expect(t.rms).toHaveLength(2); expect(t.intent()).toBe("done");
    if (code === "EACCES") {
      expect(r.cards.map((c) => [c.taskId, c.step])).toEqual([["A", "handoff"]]);
      expect(t.notices).toHaveLength(1); expect(t.notices[0]).toContain("删除失败：EACCES");
    } else {
      expect(r.cards.map((c) => [c.taskId, c.step])).toEqual([["A", "retired"]]); expect(t.notices).toEqual([]);
    }
  });
}

test("SchedulerStopped from tmp rm still aborts the tick under the fence", async () => {
  const t = tmpFixture(() => { throw new SchedulerStopped(); });
  await expect(schedulerRetireTick(t.f.db, ["p"], withSchedulerV2Retire(t.f.db, t.f.deps))).rejects.toBeInstanceOf(SchedulerStopped);
  expect(t.rms).toHaveLength(1); expect(t.notices).toEqual([]); expect(t.intent()).toBe("submitted");
});
