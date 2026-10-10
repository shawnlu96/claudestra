/**
 * S2D2 · skip cards on the merge-side paths that S2D's five hooks did not cover: the merge train, lock yield, the lent-slot reclaim
 * and the manual merge claim. Real step functions on a temp ledger; one card in a `migrating` feature and one in an `execution`
 * feature (no S2D port, so route skip) get 0 ledger writes, 0 inner manager calls and 0 gh calls, while a plain local card still
 * advances in the same run. Each case also runs once without the S2D2 gate (raw manager / main's candidate read) to show the
 * skip card would be acted on there (old red).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { mergeTrainTick, trainCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import type { TrainGh, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";
import { lockYieldStep } from "../src/lib/scheduler-lock-yield-deps.js";
import { reclaimLentSlots } from "../src/lib/scheduler-merge-reclaim.js";
import { manualMergeGate } from "../src/lib/manual-merge-queue-pass.js";
import { RECOVERY_POLICY_PATH, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { configureSchedulerV2Pass, type SchedulerV2FeatureMode } from "../src/lib/scheduler-v2-pass.js";
import { schedulerV2SkipManager } from "../src/lib/scheduler-v2-skip.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { reclaimWorld } from "./scheduler-merge-reclaim-world.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
const cleanups: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Pass(null); while (cleanups.length) cleanups.pop()!(); });

const MIGRATING: SchedulerV2FeatureMode = { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "batch", kind: "execute" } };
const EXECUTION: SchedulerV2FeatureMode = { authorityMode: "execution", sharedPlanning: true };
const head = (i: number) => String(i).repeat(40).slice(0, 40);

/** Binds cards to features and writes the mode file next to the ledger (the file S2D's route and S2G's gate both read). */
function features(db: Database, bind: Record<string, { featureId: string; mode: SchedulerV2FeatureMode }>): void {
  const modes: Record<string, SchedulerV2FeatureMode> = {};
  for (const [taskId, { featureId, mode }] of Object.entries(bind)) {
    db.query("INSERT OR IGNORE INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES (?,?,?,'active','owner',1,1)")
      .run(featureId, getTask(db, taskId)!.project, `synthetic ${featureId}`);
    db.query("UPDATE tasks SET featureId=? WHERE id=?").run(featureId, taskId);
    modes[featureId] = mode;
  }
  writeFileSync(join(dirname(db.filename), "shared-ledger-modes.json"), JSON.stringify({ features: modes }));
}
const SKIP = { M: { featureId: "fm", mode: MIGRATING }, E: { featureId: "fe", mode: EXECUTION } };

function tempLedger(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix)), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const info = spyOn(console, "info").mockImplementation(() => {});
  cleanups.push(() => info.mockRestore());
  return db;
}
const eventsOf = (db: Database, ...ids: string[]) => ids.map((id) => db.query("SELECT COUNT(*) AS n FROM events WHERE target=?").get(id) as { n: number })
  .map((r) => r.n);
function spy(answer: (args: string[]) => Record<string, unknown> = () => ({ ok: true })) {
  const calls: string[][] = [];
  const manager: Manager = async (...args) => { calls.push(args); return answer(args); };
  return { calls, manager };
}

describe("S2D2 merge train", () => {
  /** Auto code cards in merge with a passing review at their head (train-ledger test shape). */
  function trainLedger(ids: string[]) {
    const db = tempLedger("s2d2-train-"), ctx = { actor: "owner", now: 100 };
    ids.forEach((id, i) => {
      createTask(db, ctx, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
      setWorkflow(db, ctx, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
      db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?")
        .run(head(i + 1), `https://github.com/example/s2d2/pull/${i + 1}`, `task/${id}`, 100 + i, id);
      db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(id, JSON.stringify({
        round: 1, head: head(i + 1), verdict: "pass", reviewer: "agent-review", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md",
        findings: [], p0: 0, p1: 0, p2: 0 }));
    });
    let state: TrainState | null = null;
    const store: TrainStore = { load: () => state, all: () => (state ? [state] : []), save: (s) => { state = structuredClone(s); },
      event: () => {}, nextSeq: () => 1 };
    const gh: string[] = [];
    const real = { mainHead: async () => "f".repeat(40), prFiles: async (pr: string) => [pr], prHead: async (pr: string) => head(Number(pr.split("/").pop())),
      createBranch: async () => {}, mergeInto: async () => "merged" as const, openDraft: async () => 1,
      checks: async () => [{ name: "check", bucket: "pending" as const }] } as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fake = new Proxy({}, { get: (_t, k: string) => async (...a: unknown[]) => { gh.push(k); return real[k]?.(...a); } }) as TrainGh;
    const tick = () => mergeTrainTick(db, ["p"], { notifyPm: async () => {}, now: () => 1 }, { gh: fake, store }, () => ["check"]);
    return { db, gh, tick, state: () => state };
  }

  test("skip cards never become train candidates; main's candidate read still lists them (old red)", async () => {
    const t = trainLedger(["L1", "L2", "M", "E"]);
    features(t.db, SKIP);
    expect(trainCandidates(t.db, "p").map((c) => c.taskId)).toEqual(["L1", "L2", "M", "E"]); // what mergeTrainTick formed from before S2D2
    const before = eventsOf(t.db, "M", "E");
    await t.tick();
    expect(t.state()!.members.map((m) => m.taskId)).toEqual(["L1", "L2"]);
    expect(eventsOf(t.db, "M", "E")).toEqual(before);
    expect(t.gh.filter((k) => k === "prFiles")).toHaveLength(2); // only the local cards' PRs were listed
  });

  test("a live train that carries a card which turned skip is not stepped: 0 gh calls until it is local again", async () => {
    const t = trainLedger(["L1", "M"]);
    await t.tick();
    expect(t.state()!.members.map((m) => m.taskId)).toEqual(["L1", "M"]);
    t.gh.length = 0;
    await t.tick(); // control (main's behaviour): a live train is stepped, which reads GitHub
    expect(t.gh.length).toBeGreaterThan(0);
    for (const bind of [{ M: SKIP.M }, { M: { featureId: "fe", mode: EXECUTION } }]) {
      features(t.db, bind);
      const seq = t.state()!.seq, events = eventsOf(t.db, "L1", "M");
      t.gh.length = 0;
      await t.tick();
      await t.tick();
      expect(t.gh).toEqual([]);
      expect([t.state()!.seq, eventsOf(t.db, "L1", "M")]).toEqual([seq, events]);
    }
  });
});

describe("S2D2 lock yield", () => {
  const HOUR = 3_600_000, NOW = 10 * HOUR;
  function yieldLedger() {
    const db = tempLedger("s2d2-yield-");
    for (const id of ["L", "M", "E"]) {
      const old = NOW - 5 * HOUR;
      createTask(db, { actor: "owner", now: old }, { project: "p", id, title: id, kind: "code", agent: `agent-${id}`, extra: { fileGlobs: [`src/${id}/**`] } });
      setWorkflow(db, { actor: "owner", now: old }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
      db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, 'p', 'write', 'dispatch', ?, 0, 1, 1, 2, 'done', 'old write', ?, ?)`, [`i-${id}`, id, `agent-${id}`, old, old]);
      db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, ?, ?, ?, 'card')", [`src/${id}/**`, id, `i-${id}`, old]);
      db.run("UPDATE tasks SET stage = 'blocked', stageBefore = 'build' WHERE id = ?", [id]);
      insertEvent(db, { actor: "pm", now: NOW - 3 * HOUR }, { project: "p", target: id, kind: "stage", data: { from: "build", to: "blocked" } }, false);
    }
    features(db, SKIP);
    const config = { projects: { p: { maxActiveWorkers: 2 } } } as unknown as SchedulerConfig;
    const on: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null, source: "config" });
    const run = (manager: Manager) => lockYieldStep(db, config, manager, async () => {}, on, { agents: async () => new Map(), now: () => NOW });
    return { db, run };
  }
  const targets = (calls: string[][]) => calls.filter((c) => c[1] === "scheduler-lock-yield").map((c) => c[2]);

  test("old red: the raw manager is asked to yield the migrating and the execution card's locks", async () => {
    const y = yieldLedger(), s = spy();
    expect(await y.run(s.manager)).toEqual([]);
    expect(targets(s.calls).sort()).toEqual(["E", "L", "M"]);
  });

  test("gated: skip cards get 0 calls and 0 events; the local card still yields", async () => {
    const y = yieldLedger(), s = spy(), before = eventsOf(y.db, "M", "E");
    const failed = await y.run(schedulerV2SkipManager(y.db, s.manager));
    expect(targets(s.calls)).toEqual(["L"]);
    expect(failed.map((f) => f.taskId).sort()).toEqual(["lock-yield E", "lock-yield M"]); // held, visible in the pass's failure log
    expect(failed.every((f) => f.error.includes("v2 route skip"))).toBe(true);
    expect(eventsOf(y.db, "M", "E")).toEqual(before);
  });
});

describe("S2D2 lent-slot reclaim", () => {
  /** One project per card: each holds a lender run (ready, submitted merge intent, last slot turn = yield) and a free merge slot. */
  function reclaimLedger() {
    const db = tempLedger("s2d2-reclaim-"), ctx = { actor: "owner", now: 100 };
    ["L", "M", "E"].forEach((id, i) => {
      const project = `p${id}`, h = head(i + 1), pr = `https://github.com/example/s2d2/pull/${i + 1}`;
      createTask(db, ctx, { project, id, title: id, kind: "code", agent: "agent-author" });
      setWorkflow(db, ctx, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
      db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=? WHERE id=?").run(h, pr, `task/${id}`, id);
      db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review',?,?,'review','',?)").run(project, id, JSON.stringify({
        round: 1, head: h, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 }));
      db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        VALUES (?,?,?,'merge_deploy','merge',3,4,2,1,?,2,'submitted','r',100,100)`).run(`m-${id}`, id, project, h);
      db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,rev,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,'check','ready',1,100,100)`).run(`m-${id}`, id, project, pr, `task/${id}`, h);
      db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (101,'scheduler',?,?,'scheduler','',?)")
        .run(project, id, JSON.stringify({ op: "merge_slot", intentId: `m-${id}`, turn: "yield" }));
    });
    features(db, SKIP);
    const store = { load: () => null } as unknown as TrainStore;
    return { db, run: (m: Manager) => reclaimLentSlots(db, ["pL", "pM", "pE"], m, store, 1000) };
  }
  const steps = (calls: string[][]) => calls.filter((c) => c[1] === "scheduler-merge-step").map((c) => c[2]);

  test("old red: the raw manager reclaims the skip cards' slots too", async () => {
    const r = reclaimLedger(), s = spy();
    expect((await r.run(s.manager)).reclaimed).toEqual(["L", "M", "E"]);
    expect(steps(s.calls)).toEqual(["m-L", "m-M", "m-E"]);
  });

  test("gated: the local lender takes its slot back; the skip lenders are held with no call and no event", async () => {
    const r = reclaimLedger(), s = spy(), before = eventsOf(r.db, "M", "E");
    const out = await r.run(schedulerV2SkipManager(r.db, s.manager));
    expect(out.reclaimed).toEqual(["L"]);
    expect(steps(s.calls)).toEqual(["m-L"]);
    expect(out.failed.map((f) => f.taskId)).toEqual(["M", "E"]);
    expect(eventsOf(r.db, "M", "E")).toEqual(before);
  });
});

describe("S2D2 manual merge claim", () => {
  const PM = "agent-pm";
  /** A PM-requested manual merge for `id` heads the queue (manual-merge-queue-world.test.ts shape). */
  async function manualQueue(id: string) {
    const w = reclaimWorld({ store: "memory" });
    cleanups.push(() => w.close());
    cleanups.push(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));
    const info = spyOn(console, "info").mockImplementation(() => {});
    cleanups.push(() => info.mockRestore());
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "on" } } } }));
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
    const as = (actor: string, ...args: string[]) => runLedger(args, { db: w.db, actor, projectIds: ["p"],
      loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
    const c = w.card(id), db = w.db;
    db.query("DELETE FROM scheduler_sessions WHERE taskId = ?").run(id);
    db.query("DELETE FROM scheduler_intents WHERE taskId = ?").run(id);
    setWorkflow(db, { actor: "owner", now: Date.now() }, { taskId: id, taskRev: getTask(db, id)!.rev, workflowRev: 1, template: "code", templateVersion: 2,
      mode: "manual", authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管，人工审查后合并" });
    db.query("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = ?").run(id);
    const dir = mkdtempSync(join(tmpdir(), "s2d2-findings-")), findings = join(dir, "findings.json");
    writeFileSync(findings, "[]");
    const reviewed = await as(PM, "review", id, "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", c.head,
      "--session", `rs-${id}`, "--family", "codex", "--findings", findings, "--path", "r.md", "--to", "merge");
    rmSync(dir, { recursive: true, force: true });
    expect(reviewed.ok).toBe(true);
    const reviewSeq = listEvents(db, { project: "p", target: id }).findLast((e) => e.kind === "review")!.seq;
    expect(await as(PM, "manual-merge-request", id, "--head", c.head, "--spec-rev", "1", "--round", "1",
      "--review-seq", String(reviewSeq), "--reason", "人工审过，排队合并")).toMatchObject({ ok: true, state: "queued" });
    const config = { projects: { p: { requiredChecks: ["check"] } } } as unknown as SchedulerConfig;
    const claim = (m: Manager) => manualMergeGate(db, w.store).claim(m, config);
    return { db, claim };
  }
  const claims = (calls: string[][]) => calls.filter((c) => c[1] === "manual-merge-claim");

  for (const [label, mode] of [["migrating", MIGRATING], ["execution", EXECUTION]] as const) {
    test(`queue head in a ${label} feature: held with 0 inner calls and 0 events; the raw manager would claim it (old red)`, async () => {
      const q = await manualQueue("Q");
      features(q.db, { Q: { featureId: "fq", mode } });
      const raw = spy(() => ({ ok: true, claimed: false }));
      await q.claim(raw.manager);
      expect(claims(raw.calls)).toHaveLength(1);
      const s = spy(), before = eventsOf(q.db, "Q");
      const out = await q.claim(schedulerV2SkipManager(q.db, s.manager));
      expect(s.calls).toEqual([]);
      expect(out.claimed).toEqual([]);
      expect(out.failed[0]?.error).toContain("v2 route skip");
      expect(eventsOf(q.db, "Q")).toEqual(before);
    });
  }

  test("queue head is a local card: the claim goes through the gate unchanged", async () => {
    const q = await manualQueue("Q");
    const s = spy(() => ({ ok: true, claimed: true, taskId: "Q" }));
    const out = await q.claim(schedulerV2SkipManager(q.db, s.manager));
    expect(claims(s.calls)).toHaveLength(1);
    expect(out.claimed).toEqual(["Q"]);
  });
});
