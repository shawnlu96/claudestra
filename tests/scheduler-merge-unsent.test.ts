/** MRGUNK1: real merge/auto ticks against a disposable ledger and fake GitHub. */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { advanceMergeRun, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getMeta, listEvents } from "../src/lib/ledger-store.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { MERGE_STATE_UNKNOWN_LIMIT_MS, type MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { createTask } from "../src/lib/ledger-write.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { unsentRetryPlan } from "../src/lib/scheduler-merge-unsent-plan.js";
import { SLOT_RECLAIM, SLOT_YIELD } from "../src/lib/scheduler-merge-train-hold.js";

let savedPolicy: string | null;
beforeEach(() => { savedPolicy = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; });
const T0 = Date.UTC(2026, 9, 11);
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/mrgunk" } } });
afterEach(() => {
  setSystemTime();
  if (savedPolicy === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
  else writeFileSync(RECOVERY_POLICY_PATH, savedPolicy);
});
function mode(value: "on" | "observe" | "off") {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeUnsentCancel: value } } } }));
}
async function fixture(value: "on" | "observe" | "off", phase: MergePhase = "ready") {
  const f = autoFixture();
  mode(value);
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  await f.tick();
  expect((await f.review("pass", H1, [])).ok).toBe(true);
  await f.tick();
  f.db.query("UPDATE tasks SET pr=?, branch=? WHERE id='T1'").run("https://github.com/example/repo/pull/1", "task/T1");
  await f.tick();
  const calls: string[] = [];
  const gh: MergeExternal = {
    inspect: async () => ({ state: "OPEN", head: f.task().headSHA!, branch: "task/T1", base: "main", draft: false,
      crossRepository: false, mergeState: "UNKNOWN", checks: [], mergeSha: null }),
    freshness: async () => ({ behindBy: 0, mainHead: "b".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "unused" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async () => { calls.push("merge"); return "c".repeat(40); },
  };
  const intent = () => f.intents().filter((i) => i.action === "merge" && getIntent(f.db, i.id)?.taskId === "T1").at(-1)!.id;
  const run = () => getMergeRun(f.db, intent())!;
  const tick = async (at: number) => {
    setSystemTime(new Date(at));
    await schedulerMergeTick(f.db, config, async (...args) => f.cliWith({ now: () => Date.now() }, "scheduler", ...args.slice(1)), () => gh);
  };
  await tick(T0);
  if (phase !== "ready") {
    advanceMergeRun(f.db, { actor: "scheduler", now: T0 }, { intentId: intent(), from: "ready", to: phase === "merging" ? "await_ci" : phase,
      rev: run().rev, receipt: "synthetic CI pending" });
    if (phase === "merging") advanceMergeRun(f.db, { actor: "scheduler", now: T0 },
      { intentId: intent(), from: "await_ci", to: "merging", rev: run().rev });
    await tick(T0);
  }
  const end = (receipt = "GitHub 合并状态 10 分钟仍未算出") => advanceMergeRun(f.db, { actor: "scheduler", now: Date.now() },
    { intentId: intent(), from: run().phase, to: "unknown", rev: run().rev, receipt });
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  return { ...f, mergeTick: tick, run, end, intent, calls, events, gh };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function withFixture(value: "on" | "observe" | "off", phase: MergePhase, body: (f: F) => Promise<void>) {
  const f = await fixture(value, phase);
  try { await body(f); } finally { f.close(); }
}
const observations = (f: F) => f.events().filter((e) => e.data.mechanism === "mergeUnsentCancel");
const cancellations = (f: F) => f.events().filter((e) => e.data.op === "merge_unsent_cancel");
function cancelled(f: F) {
  expect(f.run().phase).toBe("resolved");
  expect(getIntent(f.db, f.intent())?.status).toBe("cancelled");
  expect(f.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(f.intent())).toBeNull();
  expect(f.task().stage).toBe("merge");
}

describe("MRGUNK1 unsent merge recovery", () => {
  test("[验收线 1] slot yield and reclaim clear the clock; fifteen idle minutes never consume the new ten minutes", async () => {
    await withFixture("on", "ready", async (f) => {
      const turn = (receipt: string, at: number) => advanceMergeRun(f.db, { actor: "scheduler", now: at },
        { intentId: f.intent(), from: "ready", to: "ready", rev: f.run().rev, receipt });
      expect(f.run().unknownSince).toBe(T0);
      turn(`${SLOT_YIELD}等列车`, T0 + 1000);
      expect(f.run().unknownSince).toBeNull();
      // Reclaim also clears a clock persisted by an older controller while the slot was lent.
      f.db.query("UPDATE scheduler_merges SET unknownSince=? WHERE intentId=?").run(T0, f.intent());
      const back = T0 + 15 * 60_000;
      turn(SLOT_RECLAIM, back);
      expect(f.run().unknownSince).toBeNull();
      await f.mergeTick(back);
      expect(f.run()).toMatchObject({ phase: "ready", unknownSince: back });
      await f.mergeTick(back + MERGE_STATE_UNKNOWN_LIMIT_MS - 1);
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
      await f.mergeTick(back + MERGE_STATE_UNKNOWN_LIMIT_MS);
      cancelled(f);
    });
  });
  for (const phase of ["ready", "await_ci"] as const) {
    test(`[验收线 2] on ${phase}: timeout cancels, next real auto tick plans another merge`, async () => {
      await withFixture("on", phase, async (f) => {
        const first = f.intent();
        await f.mergeTick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
        cancelled(f);
        expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
        expect(await f.tick()).toMatchObject({ step: "merge_queue" });
        expect(f.intent()).not.toBe(first);
        expect(f.calls).toEqual([]);
      });
    });
  }
  test("[验收线 2] updating and merging remain unknown and frozen", async () => {
    for (const phase of ["updating", "merging"] as const) await withFixture("on", phase, async (f) => {
      await f.mergeTick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
      expect(f.run().phase).toBe("unknown");
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(true);
      expect(cancellations(f)).toHaveLength(0);
    });
  });
  test("[验收线 4] third cancellation goes through real fallback and notifies PM exactly once", async () => {
    await withFixture("on", "ready", async (f) => {
      const commands: string[] = [], manager = f.tickDeps.manager;
      f.tickDeps.manager = async (...args) => { commands.push(args[1]!); return manager(...args); };
      for (let i = 1; i <= 3; i++) {
        f.end();
        cancelled(f);
        commands.length = 0;
        const step = await f.tick();
        if (i < 3) {
          expect(step?.step).toBe("merge_queue");
          await f.mergeTick(T0 + i * 1000);
        } else {
          expect(step).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
          expect(commands).not.toContain("scheduler-plan");
          expect(commands).toContain("scheduler-fallback-manual");
        }
      }
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      await f.tick(); await f.tick();
      expect(f.notices.filter((n) => n.includes("merge_bounce_limit"))).toHaveLength(1);
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
    });
  });
  for (const value of ["observe", "off"] as const) {
    test(`[验收线 5] ${value} preserves unknown + freeze and observes at most once per intent`, async () => {
      await withFixture(value, "ready", async (f) => {
        await f.mergeTick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
        expect(f.run().phase).toBe("unknown");
        expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(true);
        expect(getIntent(f.db, f.intent())?.status).toBe("submitted");
        await f.mergeTick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1);
        expect(observations(f)).toHaveLength(value === "observe" ? 1 : 0);
        if (value === "observe") expect(observations(f)[0]!.text).toContain("本会取消、不冻结");
        expect(cancellations(f)).toHaveLength(0);
      });
    });
  }
});


describe("MRGUNK1 collateral and journal boundaries", () => {
  for (const phase of ["ready", "await_ci"] as const) test(`[验收线 3] ${phase} collateral cancels without counting or another unknown`, async () => {
    await withFixture("on", phase, async (f) => {
      const first = f.intent();
      createTask(f.db, { actor: "owner" }, { project: "p", id: "Other", title: "in-flight update", kind: "code" });
      f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        SELECT 'other-merge','Other',project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt
        FROM scheduler_intents WHERE id=?`).run(first);
      f.db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
        SELECT 'other-merge','Other',project,prRef,expectedBranch,reviewedHead,requiredChecks,'updating',createdAt,updatedAt
        FROM scheduler_merges WHERE intentId=?`).run(first);
      advanceMergeRun(f.db, { actor: "scheduler", now: T0 }, { intentId: "other-merge", from: "updating", to: "unknown", rev: 1, receipt: "update uncertain" });
      const frozen = getMeta(f.db, "p").queueFrozen;
      await f.mergeTick(T0 + 1);
      cancelled(f);
      expect(getMeta(f.db, "p").queueFrozen).toEqual(frozen);
      expect(cancellations(f)).toHaveLength(1);
      expect(cancellations(f)[0]!.data).toMatchObject({ counted: false, receipt: "项目合并队列已冻结" });
      expect(f.events().filter((e) => e.data.op === "merge_phase" && e.data.to === "unknown")).toHaveLength(0);
    });
  });
  test("[验收线 4] changed head or successful merge breaks the streak, but forged markers cannot release a retry", async () => {
    await withFixture("on", "ready", async (f) => {
      for (let i = 0; i < 3; i++) {
        f.end();
        if (i < 2) { await f.tick(); await f.mergeTick(T0 + i + 1); }
      }
      const snapshot = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 });
      const last = getIntent(f.db, f.intent())!;
      expect(unsentRetryPlan(snapshot.events, last, snapshot.task)).toBe("limit");
      const firstMarker = cancellations(f)[0]!, lastMarker = cancellations(f).at(-1)!;
      // A real task set-away/set-back pair, or a successful merge, between earlier cancellations ends the streak.
      for (const reset of [
        { kind: "task" as const, data: { op: "set", patch: { headSHA: "e".repeat(40) } } },
        { kind: "task" as const, data: { op: "set", patch: { headSHA: null } } },
        { kind: "scheduler" as const, data: { op: "merge_phase", to: "merged" } },
      ]) {
        const events = snapshot.events.flatMap((e) => e.seq === firstMarker.seq
          ? [e, { ...e, seq: e.seq + 0.1, dedupKey: null, ...reset }] : [e]);
        expect(unsentRetryPlan(events, last, snapshot.task)).toBe("retry");
      }
      for (const twist of [
        { dedupKey: "forged" }, { data: { ...lastMarker.data, imported: true } },
        { data: { ...lastMarker.data, head: "e".repeat(40) } }, { data: { ...lastMarker.data, specRev: 99 } },
      ]) {
        const events = snapshot.events.map((e) => e.seq === lastMarker.seq ? { ...e, ...twist } : e);
        expect(unsentRetryPlan(events, last, snapshot.task)).toBe("other");
      }
      const result = await f.tick();
      expect(result?.step).toBe("manual");
      await f.tick(); await f.tick();
      expect(f.notices.filter((n) => n.includes("merge_bounce_limit"))).toHaveLength(1);
    });
  });
  for (const value of ["on", "observe", "off"] as const) test(`[验收线 5] ${value}: PM takeover still follows manualCancel`, async () => {
    await withFixture(value, "ready", async (f) => {
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
      f.end("PM took over");
      cancelled(f);
      expect(observations(f)).toHaveLength(0);
      expect(cancellations(f)).toHaveLength(0);
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
    });
  });
  test("[验收线 2] a row rewound after a merging claim is never treated as unsent", async () => {
    await withFixture("on", "ready", async (f) => {
      advanceMergeRun(f.db, { actor: "scheduler" }, { intentId: f.intent(), from: "ready", to: "await_ci", rev: f.run().rev, receipt: "CI waiting" });
      advanceMergeRun(f.db, { actor: "scheduler" }, { intentId: f.intent(), from: "await_ci", to: "merging", rev: f.run().rev });
      f.db.query("UPDATE scheduler_merges SET phase='await_ci' WHERE intentId=?").run(f.intent());
      f.end();
      expect(f.run().phase).toBe("unknown");
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(true);
    });
  });
});

for (const value of ["on", "observe", "off"] as const) test(`[验收线 5] ${value}: the existing uiUnsentEnd still takes precedence`, async () => {
  await withFixture(value, "ready", async (f) => {
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeUnsentCancel: value, uiReviewCarry: "on" } } } }));
    f.db.query("UPDATE task_workflows SET template='ui' WHERE taskId='T1'").run();
    f.end("UI screenshot approval withdrawn");
    cancelled(f);
    expect(f.events().some((e) => e.data.uiUnsent === true)).toBe(true);
    expect(cancellations(f)).toHaveLength(0);
    expect(observations(f)).toHaveLength(0);
    expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
  });
});

test("[验收线 2] await_ci after a finished updating step is unsent too", async () => {
  await withFixture("on", "updating", async (f) => {
    advanceMergeRun(f.db, { actor: "scheduler", now: T0 },
      { intentId: f.intent(), from: "updating", to: "await_ci", rev: f.run().rev, receipt: "update complete, CI pending" });
    await f.mergeTick(T0);
    await f.mergeTick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
    cancelled(f);
    expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
  });
});

test("[验收线 5] missing recovery config defaults to one observation, and stale CAS replay adds nothing", async () => {
  await withFixture("off", "ready", async (f) => {
    rmSync(RECOVERY_POLICY_PATH);
    const input = { intentId: f.intent(), from: "ready" as const, to: "unknown" as const, rev: f.run().rev, receipt: "read failed" };
    advanceMergeRun(f.db, { actor: "scheduler", now: T0 }, input);
    expect(f.run()).toMatchObject({ phase: "unknown", reason: "read failed", unknownSince: null });
    expect(observations(f)).toHaveLength(1);
    expect(() => advanceMergeRun(f.db, { actor: "scheduler", now: T0 + 1 }, input)).toThrow(/不能从/);
    expect(observations(f)).toHaveLength(1);
  });
});

test("[验收线 3] a collateral cancellation between two real failures leaves one retry before the limit", async () => {
  await withFixture("on", "ready", async (f) => {
    for (const receipt of ["read failed", "项目合并队列已冻结", "read failed again"]) {
      f.end(receipt);
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      await f.mergeTick(T0);
    }
    expect(cancellations(f).map((e) => e.data.counted)).toEqual([true, false, true]);
    f.end("third real failure");
    expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
    expect(f.notices.filter((n) => n.includes("merge_bounce_limit"))).toHaveLength(1);
  });
});

test("[验收线 4] a newly observed and reviewed head gets a fresh cancellation budget", async () => {
  await withFixture("on", "ready", async (f) => {
    f.end("first"); await f.tick(); await f.mergeTick(T0);
    f.end("second"); await f.tick(); await f.mergeTick(T0);
    const newHead = "2".repeat(40);
    advanceMergeRun(f.db, { actor: "scheduler", now: T0 }, { intentId: f.intent(), from: "ready", to: "await_review",
      rev: f.run().rev, receipt: "author pushed a new head; review again", newHead });
    await f.tick();
    expect((await f.review("pass", newHead, [])).ok).toBe(true);
    await f.tick(); await f.tick(); await f.mergeTick(T0);
    f.end("new head first failure");
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    expect(f.notices.filter((n) => n.includes("merge_bounce_limit"))).toHaveLength(0);
  });
});
