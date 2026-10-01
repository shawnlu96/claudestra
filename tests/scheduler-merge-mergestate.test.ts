/**
 * i28-M12b: right after main moves GitHub reports mergeStateStatus=UNKNOWN with no checks for a while. That is a wait,
 * not an unobservable result: the run stays in its phase (no unknown, no freeze) until GitHub decides, bounded by a limit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { closeLedger, getMeta, LEDGER_SCHEMA_VERSION, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, MERGE_UNKNOWN_CLEAR, MERGE_UNKNOWN_WAIT, resolveMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { MERGE_STATE_UNKNOWN_LIMIT_MS, UNKNOWN_LIMIT_REASON, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { bounceReceipt, bounceReviewLine, bounceWork, fixBounce, parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { renderBouncePush } from "../src/lib/peer-pr-message.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const ID = "M12B", INTENT = `merge-${ID}`;
const H = "a".repeat(40), N = "d".repeat(40), MAIN = "e".repeat(40), M = "b".repeat(40), X = "f".repeat(40);
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p" } } });

const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: `task/${ID}`, base: "main", draft: false,
  crossRepository: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });
const computing = () => pr({ mergeState: "UNKNOWN", checks: [] });

function fixture(phase: MergePhase) {
  const dir = mkdtempSync(join(tmpdir(), "m12b-merge-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id: ID, title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, ctx, { taskId: ID, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=? WHERE id=?").run(H, "https://github.com/example/repo/pull/42", `task/${ID}`, ID);
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(ID, JSON.stringify({
    round: 1, head: H, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs", reviewerFamily: "codex",
    path: `reviews/${ID}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 }));
  const intent = (iid: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,
    causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt) VALUES (?,?,'p',?,?,3,4,2,1,?,2,?,'r',100,100)`)
    .run(iid, ID, node, action, H, status);
  intent(INTENT, "merge_deploy", "merge", "submitted");
  intent("rc", "adversarial_review", "ensure_session", "done");
  for (const resource of [`task:${ID}`, "merge:p"]) {
    db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p',?,?,?,100)").run(resource, ID, INTENT);
  }
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-review','rs','codex','acp','active','rc',100,100)`).run(ID);
  beginMergeRun(db, { actor: "scheduler", now: 101 }, INTENT, ["check"]);
  if (phase !== "ready") db.query("UPDATE scheduler_merges SET phase=? WHERE intentId=?").run(phase, INTENT);
  let snaps: (PrSnapshot | Error)[] = [pr()];
  const calls: string[] = [], gh = { behindBy: 0, carry: false };
  const external: MergeExternal = {
    inspect: async () => {
      const next = snaps.length > 1 ? snaps.shift()! : snaps[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    freshness: async () => ({ behindBy: gh.behindBy, mainHead: MAIN }),
    carryReview: async () => gh.carry ? { ok: true, reason: "净 diff 一致", mainParent: X, mainHead: MAIN, diffHash: "9".repeat(64) }
      : { ok: false, reason: "不沿用" },
    updateBranch: async () => { calls.push("update"); throw new Error("branch cannot be updated due to conflicts"); },
    merge: async () => { calls.push("merge"); return M; },
  };
  const manager = async (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"],
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
  /** One scheduler tick at wall clock `at`, with GitHub answering `next`. */
  const tick = async (next: (PrSnapshot | Error)[], at?: number) => {
    snaps = next;
    if (at !== undefined) setSystemTime(new Date(at));
    await schedulerMergeTick(db, config, manager, () => external);
  };
  const state = () => ({
    run: getMergeRun(db, INTENT)?.phase as string | undefined,
    stage: (db.query("SELECT stage FROM tasks WHERE id=?").get(ID) as { stage: string }).stage,
    frozen: getMeta(db, "p").queueFrozen.frozen,
  });
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, path, tick, state, close, calls, gh, external };
}
type F = ReturnType<typeof fixture>;
const with_ = async (phase: MergePhase, body: (f: F) => Promise<void>) => {
  const f = fixture(phase);
  try { await body(f); } finally { f.close(); }
};
afterEach(() => { setSystemTime(); });

const T0 = Date.UTC(2026, 9, 2, 1, 11);
const WAITING = (run: string) => ({ run, stage: "merge", frozen: false });

/** A fresh process has no driver memory; only this file-backed journal can carry the clock across restarts. */
async function restartedTick(f: F, at: number, snapshot = computing()): Promise<void> {
  const module = (name: string) => JSON.stringify(join(import.meta.dir, `../src/lib/${name}.ts`));
  const script = `
    const { openLedger, closeLedger } = await import(${module("ledger-store")});
    const { getMergeRun, advanceMergeRun } = await import(${module("scheduler-merge")});
    const { driveMerge } = await import(${module("scheduler-merge-driver")});
    Date.now = () => ${at};
    const db = openLedger(${JSON.stringify(f.path)});
    const unexpected = async () => { throw new Error("unexpected external effect"); };
    const external = { inspect: async () => (${JSON.stringify(snapshot)}), freshness: unexpected,
      updateBranch: unexpected, merge: unexpected,
      carryReview: async () => ({ ok: true, mainParent: "${X}", mainHead: "${MAIN}", diffHash: "${"9".repeat(64)}" }) };
    await driveMerge(getMergeRun(db, "${INTENT}"), external, async (from, to, rev, receipt, mergeSha, newHead) =>
      advanceMergeRun(db, { actor: "scheduler" }, { intentId: "${INTENT}", from, to, rev, receipt, mergeSha, newHead }));
    closeLedger(${JSON.stringify(f.path)});
  `;
  const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDESTRA_STATE_DIR: f.path + ".state" },
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}

describe("i28-M12c durable UNKNOWN wait", () => {
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`${phase}: repeated process restarts retain the first timestamp and expire at ten minutes`, async () => {
      await with_(phase, async (f) => {
        await f.tick([computing()], T0);
        expect(getMergeRun(f.db, INTENT)?.unknownSince).toBe(T0);
        const rev = getMergeRun(f.db, INTENT)?.rev;
        for (const offset of [240_000, MERGE_STATE_UNKNOWN_LIMIT_MS - 1]) {
          await restartedTick(f, T0 + offset);
          expect(f.state()).toEqual(WAITING(phase));
          expect(getMergeRun(f.db, INTENT)).toMatchObject({ unknownSince: T0, rev });
        }
        await restartedTick(f, T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
        expect(f.state()).toEqual({ run: "unknown", stage: "merge", frozen: true });
        expect(getMergeRun(f.db, INTENT)).toMatchObject({ unknownSince: null, reason: UNKNOWN_LIMIT_REASON });
        expect(f.calls).toEqual([]);
      });
    });
  }
  test("carried head UNKNOWN and final pre-merge UNKNOWN persist their clocks too", async () => {
    for (const phase of ["updating", "await_ci"] as const) {
      await with_(phase, async (f) => {
        f.gh.carry = true;
        const snapshot = phase === "updating" ? pr({ head: N, mergeState: "UNKNOWN", checks: [] }) : computing();
        await f.tick(phase === "await_ci" ? [pr(), snapshot] : [snapshot], T0);
        expect(getMergeRun(f.db, INTENT)?.unknownSince).toBe(T0);
        await restartedTick(f, T0 + MERGE_STATE_UNKNOWN_LIMIT_MS, snapshot);
        expect(f.state().run).toBe("unknown");
        expect(f.calls).toEqual([]);
      });
    }
  });
  test("a non-UNKNOWN or draft observation clears the durable streak even when the phase stays put", async () => {
    for (const snapshot of [pr({ checks: [{ name: "check", bucket: "pending" }] }), pr({ draft: true, mergeState: "UNKNOWN" })]) {
      await with_("await_ci", async (f) => {
        await f.tick([computing()], T0);
        await f.tick([snapshot], T0 + 60_000);
        expect(getMergeRun(f.db, INTENT)?.unknownSince).toBeNull();
        await restartedTick(f, T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
        expect(f.state()).toEqual(WAITING("await_ci"));
        expect(getMergeRun(f.db, INTENT)?.unknownSince).toBe(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
      });
    }
  });
  test("bounce clears the old run; the same card's next merge starts with a new clock", async () => {
    await with_("ready", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([pr({ mergeState: "DIRTY" })], T0 + 30_000);
      expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
      expect(getMergeRun(f.db, INTENT)?.unknownSince).toBeNull();
      // Model a fresh passing review, then a new scheduler merge intent for the same card.
      f.db.query("UPDATE tasks SET stage='merge', rev=rev+1 WHERE id=?").run(ID);
      f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
        SELECT ?,actor,project,target,kind,text,json_set(data,'$.round',(SELECT round FROM tasks WHERE id=?))
        FROM events WHERE target=? AND kind='review' ORDER BY seq DESC LIMIT 1`).run(T0 + 60_000, ID, ID);
      const next = `${INTENT}-next`;
      f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        SELECT ?,taskId,project,node,action,causalSeq,eventSeq,(SELECT rev FROM tasks WHERE id=?),specRev,head,templateVersion,'submitted',reason,createdAt,updatedAt
        FROM scheduler_intents WHERE id=?`).run(next, ID, INTENT);
      f.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,?)").run(ID, next, T0 + 60_000);
      const run = beginMergeRun(f.db, { actor: "scheduler" }, next, ["check"]).run;
      expect(run.unknownSince).toBeNull();
      await f.tick([computing()], T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1);
      expect(getMergeRun(f.db, next)).toMatchObject({ phase: "ready", unknownSince: T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1 });
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
    });
  });
  test("all terminal transitions clear the timestamp, including manual cancellation and human resolution", async () => {
    await with_("await_ci", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([pr(), pr(), pr({ state: "MERGED", mergeSha: M })], T0 + 30_000);
      expect(getMergeRun(f.db, INTENT)).toMatchObject({ phase: "merged", unknownSince: null });
    });
    await with_("updating", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([pr({ head: N, mergeState: "UNKNOWN" })], T0 + 30_000);
      expect(getMergeRun(f.db, INTENT)).toMatchObject({ phase: "await_review", unknownSince: null });
    });
    await with_("ready", async (f) => {
      await f.tick([computing()], T0);
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId=?").run(ID);
      await f.tick([computing()], T0 + 30_000);
      expect(getMergeRun(f.db, INTENT)).toMatchObject({ phase: "resolved", unknownSince: null });
    });
    await with_("unknown", async (f) => {
      f.db.query("UPDATE scheduler_merges SET unknownSince=? WHERE intentId=?").run(T0, INTENT);
      resolveMergeRun(f.db, { actor: "owner" }, { intentId: INTENT, outcome: "failed", receipt: "checked PR, not merged" });
      expect(getMergeRun(f.db, INTENT)).toMatchObject({ phase: "resolved", unknownSince: null });
    });
  });
  test("same-phase observations retain authorization, CAS and terminal-phase guards; repeated starts cannot reset the clock", async () => {
    await with_("ready", async (f) => {
      const input = { intentId: INTENT, from: "ready", to: "ready", rev: 1, receipt: MERGE_UNKNOWN_WAIT } as const;
      expect(() => advanceMergeRun(f.db, { actor: "agent-author", now: T0 }, input)).toThrow(/只有/);
      const run = advanceMergeRun(f.db, { actor: "scheduler", now: T0 }, input);
      expect(() => advanceMergeRun(f.db, { actor: "scheduler" }, { ...input, receipt: MERGE_UNKNOWN_CLEAR })).toThrow(/不能从/);
      const again = advanceMergeRun(f.db, { actor: "scheduler", now: T0 + 1 }, { ...input, rev: run.rev });
      expect(again).toMatchObject({ unknownSince: T0, rev: run.rev });
      expect(() => advanceMergeRun(f.db, { actor: "scheduler" }, { ...input, rev: run.rev, receipt: "arbitrary" })).toThrow(/同阶段/);
      f.db.query("UPDATE scheduler_merges SET phase='resolved' WHERE intentId=?").run(INTENT);
      expect(() => advanceMergeRun(f.db, { actor: "scheduler" }, { ...input, from: "resolved", to: "resolved", rev: run.rev })).toThrow(/活动合并/);
    });
  });
});

/**
 * Production shape (m12c-stale-reader-1): the scheduler reads through a long-lived LedgerReader opened before the deploy's first
 * CLI migrates the column in, while writes go through a separate (migrating) ledger connection.
 */
async function acrossMigration(body: (tick: (snap: PrSnapshot, at: number) => Promise<void>, db: ReturnType<typeof openLedger>) => Promise<void>) {
  await with_("await_ci", async (f) => {
    f.db.exec(`ALTER TABLE scheduler_merges DROP COLUMN unknownSince; PRAGMA user_version = ${LEDGER_SCHEMA_VERSION - 1}`);
    closeLedger(f.path);
    const reader = new LedgerReader(f.path);
    try {
      expect(getMergeRun(reader.get()!, INTENT)).not.toHaveProperty("unknownSince");
      const db = openLedger(f.path);
      expect(getMergeRun(db, INTENT)).toHaveProperty("unknownSince", null);
      const manager = async (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"],
        loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
      await body(async (snap, at) => {
        setSystemTime(new Date(at));
        await schedulerMergeTick(reader.get()!, config, manager, () => ({ ...f.external, inspect: async () => snap }));
      }, db);
    } finally { reader.close(); }
  });
}

describe("i28-M12c r1: a reader opened before the migration still sees the durable clock", () => {
  test("UNKNOWN past ten minutes → unknown and frozen", async () => {
    await acrossMigration(async (tick, db) => {
      await tick(computing(), T0);
      expect(getMergeRun(db, INTENT)).toMatchObject({ phase: "await_ci", unknownSince: T0 });
      await tick(computing(), T0 + MERGE_STATE_UNKNOWN_LIMIT_MS - 1);
      expect(getMergeRun(db, INTENT)?.phase).toBe("await_ci");
      await tick(computing(), T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
      expect(getMergeRun(db, INTENT)).toMatchObject({ phase: "unknown", unknownSince: null, reason: UNKNOWN_LIMIT_REASON });
      expect(getMeta(db, "p").queueFrozen.frozen).toBe(true);
    });
  });
  test("a same-phase non-UNKNOWN read clears the start, so a later UNKNOWN starts a new clock", async () => {
    await acrossMigration(async (tick, db) => {
      await tick(computing(), T0);
      await tick(pr({ mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "pending" }] }), T0 + 60_000);
      expect(getMergeRun(db, INTENT)).toMatchObject({ phase: "await_ci", unknownSince: null });
      await tick(computing(), T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1);
      expect(getMergeRun(db, INTENT)).toMatchObject({ phase: "await_ci", unknownSince: T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1 });
      expect(getMeta(db, "p").queueFrozen.frozen).toBe(false);
    });
  });
});

describe("i28-M12b UNKNOWN with no checks waits for GitHub instead of freezing", () => {
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`${phase}: UNKNOWN → stays put, not frozen; next tick DIRTY → conflict bounce back to fix with the conflict evidence`, async () => {
      await with_(phase, async (f) => {
        await f.tick([computing()], T0);
        expect(f.state()).toEqual(WAITING(phase));
        await f.tick([computing()], T0 + 30_000);
        expect(f.state()).toEqual(WAITING(phase));
        await f.tick([pr({ mergeState: "DIRTY", checks: [] })], T0 + 60_000);
        expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
        const stage = f.db.query("SELECT data FROM events WHERE target=? AND kind='stage' ORDER BY seq DESC LIMIT 1").get(ID) as { data: string };
        expect(JSON.parse(stage.data)).toMatchObject({ from: "merge", to: "fix", mergeBounce: { cause: "conflict", prHead: H, mainHead: MAIN } });
      });
    });
  }
  test("UNKNOWN then CLEAN with pending CI → the existing wait-for-CI path (M7), never unknown", async () => {
    await with_("ready", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([pr({ checks: [{ name: "check", bucket: "pending" }] })], T0 + 60_000);
      expect(f.state()).toEqual(WAITING("await_ci"));
      await f.tick([pr({ checks: [{ name: "check", bucket: "pending" }] })], T0 + 120_000);
      expect(f.state()).toEqual(WAITING("await_ci"));
    });
  });
});

describe("i28-M12b r1: UNKNOWN is waited out before any irreversible step", () => {
  test("ready + behind main + UNKNOWN → no update-branch yet; next tick DIRTY → conflict bounce (unknown-ready-1)", async () => {
    await with_("ready", async (f) => {
      f.gh.behindBy = 1;
      await f.tick([computing()], T0);
      expect(f.state()).toEqual(WAITING("ready"));
      expect(f.calls).toEqual([]);
      await f.tick([pr({ mergeState: "DIRTY", checks: [] })], T0 + 30_000);
      expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
      expect(f.calls).toEqual([]);
    });
  });
  test("await_ci green, then the last pre-merge read is UNKNOWN → no merging claim, waits; next tick merges (unknown-final-1)", async () => {
    await with_("await_ci", async (f) => {
      await f.tick([pr(), computing()], T0);
      expect(f.state()).toEqual(WAITING("await_ci"));
      expect(f.calls).toEqual([]);
      await f.tick([pr(), pr(), pr({ state: "MERGED", mergeSha: M })], T0 + 30_000);
      expect(f.state().run).toBe("merged");
      expect(f.calls).toEqual(["merge"]);
    });
  });
  test("await_ci green, then the last pre-merge read is DIRTY → conflict bounce, never merges", async () => {
    await with_("await_ci", async (f) => {
      await f.tick([pr(), pr({ mergeState: "DIRTY", checks: [] })], T0);
      expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
      expect(f.calls).toEqual([]);
    });
  });
});

describe("i28-M12b r3 (PM 10-02 02:4x): a refused update-branch re-reads once and goes back to fix, never waits", () => {
  const REFUSED = "branch cannot be updated due to conflicts";
  const lastBounce = (f: F) => {
    const stage = f.db.query("SELECT data FROM events WHERE target=? AND kind='stage' ORDER BY seq DESC LIMIT 1").get(ID) as { data: string };
    return JSON.parse(stage.data).mergeBounce as Record<string, unknown>;
  };
  const rereads: [string, () => PrSnapshot | Error][] = [
    ["UNKNOWN", computing], ["BEHIND", () => pr({ mergeState: "BEHIND" })], ["CLEAN", () => pr()],
    ["a moved head (UNKNOWN)", () => pr({ head: N, mergeState: "UNKNOWN", checks: [] })],
    ["a moved head (DIRTY)", () => pr({ head: N, mergeState: "DIRTY", checks: [] })], ["a failed read", () => new Error("gh pr view 超时")],
  ];
  for (const phase of ["ready", "await_ci"] as const) {
    test(`${phase}: refused update, same-head DIRTY, main lookup fails → update_fail / fix without freezing`, async () => {
      await with_(phase, async (f) => {
        let reads = 0;
        f.external.freshness = async () => {
          if (++reads > 1) throw new Error("main lookup timed out");
          return { behindBy: 1, mainHead: MAIN };
        };
        await f.tick([pr(), pr({ mergeState: "DIRTY", checks: [] })], T0);
        expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
        expect(lastBounce(f)).toEqual({ cause: "update_fail", prHead: H, mainHead: null, checks: [], error: REFUSED });
        expect(f.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(INTENT)).toBeNull();
        expect(getMergeRun(f.db, INTENT)?.unknownSince).toBeNull();
        expect(f.calls).toEqual(["update"]);
      });
    });
    test(`${phase}: re-read DIRTY on the reviewed head → the M12 conflict bounce with the conflict evidence`, async () => {
      await with_(phase, async (f) => {
        f.gh.behindBy = 1;
        await f.tick([pr(), pr({ mergeState: "DIRTY", checks: [] })], T0);
        expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
        expect(lastBounce(f)).toMatchObject({ cause: "conflict", prHead: H, mainHead: MAIN });
        expect(f.calls).toEqual(["update"]);
      });
    });
    for (const [label, reread] of rereads) {
      test(`${phase}: re-read ${label} → back to fix as update_fail with GitHub's error, not frozen, no second update`, async () => {
        await with_(phase, async (f) => {
          f.gh.behindBy = 1;
          f.gh.carry = true; // even a head that could carry the review is not followed after a refused update
          await f.tick([pr(), reread()], T0);
          expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
          expect(lastBounce(f)).toEqual({ cause: "update_fail", prHead: H, mainHead: null, checks: [], error: REFUSED });
          expect(getMergeRun(f.db, INTENT)?.reason).toBe(`update_fail: 退回 fix（update_fail）：PR head ${H}，更新分支失败：${REFUSED}；请合入 main 后重新交付`);
          await f.tick([pr({ mergeState: "BEHIND" })], T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1);
          expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
          expect(f.calls).toEqual(["update"]);
        });
      });
    }
  }
  test("losing the lease during conflict evidence lookup leaves the claimed run for the next controller", async () => {
    await with_("ready", async (f) => {
      let reads = 0;
      f.external.freshness = async () => {
        if (++reads > 1) throw new SchedulerStopped("lease lost");
        return { behindBy: 1, mainHead: MAIN };
      };
      await expect(f.tick([pr(), pr({ mergeState: "DIRTY" })], T0)).rejects.toThrow(/lease lost/);
      expect(f.state()).toEqual(WAITING("updating"));
      expect(f.calls).toEqual(["update"]);
    });
  });
  test("the fix order, the targeted re-review and the bounce count read update_fail like the other bounces", async () => {
    await with_("ready", async (f) => {
      f.gh.behindBy = 1;
      await f.tick([pr(), computing()], T0);
      const b = fixBounce(listEvents(f.db, { project: "p", target: ID }), "fix")!;
      expect(b).toMatchObject({ cause: "update_fail", prHead: H, error: REFUSED });
      expect(bounceWork(b).inputs[0]).toContain(`更新分支失败：PR head ${H}`);
      expect(bounceWork(b).acceptance[0]).toContain("合入最新 origin/main");
      expect(bounceReviewLine(b)).toContain("只看合入 main 的合并提交");
      const counted = f.db.query("SELECT data FROM events WHERE target=? AND kind='scheduler' AND json_extract(data,'$.op')='merge_conflict'").get(ID) as { data: string };
      expect(JSON.parse(counted.data)).toMatchObject({ cause: "update_fail", prHead: H, count: 1, escalated: false });
    });
  });
  test("a long multi-line error is flattened and cut so the receipt stays one line ≤ 600 and still parses", async () => {
    await with_("ready", async (f) => {
      f.gh.behindBy = 1;
      f.external.updateBranch = async () => { throw new Error(`HTTP 422\n\t${"冲突😀".repeat(300)}`); };
      await f.tick([pr(), computing()], T0);
      expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
      const receipt = bounceReceipt({ cause: "update_fail", prHead: H, mainHead: null, checks: [], error: `HTTP 422\n\t${"冲突😀".repeat(300)}` });
      expect(receipt.length).toBeLessThanOrEqual(600);
      expect(receipt).not.toMatch(/[\n\t]/);
      expect(() => encodeURIComponent(receipt)).not.toThrow(); // throws on a lone surrogate: no emoji was cut in half
      expect(parseBounceReceipt(receipt)).toMatchObject({ cause: "update_fail", prHead: H, error: expect.stringMatching(/^HTTP 422 冲突/) });
      expect(getMergeRun(f.db, INTENT)?.reason).toBe(`update_fail: ${receipt}`);
    });
  });
  test("a peer PR author is told the update failed, not that CI failed", () => {
    const text = renderBouncePush(42, { cause: "update_fail", prHead: H, checks: [] }, "reply-here");
    expect(text).toContain("更新分支失败");
    expect(text).toContain("请合入最新 main 后推送");
    expect(text).not.toContain("CI 失败");
  });
});

describe("i28-M12b r2: UNKNOWN on a carried head", () => {
  test("carried head (pure merge of main) UNKNOWN → waits; then DIRTY → carry journaled, conflict bounce on the new head (unknown-carried-1)", async () => {
    await with_("updating", async (f) => {
      f.gh.carry = true;
      await f.tick([pr({ head: N, mergeState: "UNKNOWN", checks: [] })], T0);
      expect(f.state()).toEqual(WAITING("updating"));
      await f.tick([pr({ head: N, mergeState: "DIRTY", checks: [] })], T0 + 30_000);
      expect(f.state()).toEqual({ run: "resolved", stage: "fix", frozen: false });
      const stage = f.db.query("SELECT data FROM events WHERE target=? AND kind='stage' ORDER BY seq DESC LIMIT 1").get(ID) as { data: string };
      expect(JSON.parse(stage.data)).toMatchObject({ from: "merge", to: "fix", mergeBounce: { cause: "conflict", prHead: N, mainHead: MAIN } });
      expect(f.calls).toEqual([]);
    });
  });
  test("a moved head that is not a pure merge of main still goes back to review, DIRTY or not", async () => {
    await with_("updating", async (f) => {
      await f.tick([pr({ head: N, mergeState: "DIRTY", checks: [] })], T0);
      expect(f.state()).toMatchObject({ run: "await_review", frozen: false });
    });
  });
});

describe("i28-M12b the UNKNOWN wait is bounded", () => {
  test(`UNKNOWN for ${MERGE_STATE_UNKNOWN_LIMIT_MS / 60_000} minutes → unknown with a readable reason`, async () => {
    await with_("await_ci", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([computing()], T0 + MERGE_STATE_UNKNOWN_LIMIT_MS - 1);
      expect(f.state()).toEqual(WAITING("await_ci"));
      await f.tick([computing()], T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
      expect(f.state()).toEqual({ run: "unknown", stage: "merge", frozen: true });
      expect(getMergeRun(f.db, INTENT)?.reason).toContain(UNKNOWN_LIMIT_REASON);
      expect(UNKNOWN_LIMIT_REASON).toBe("GitHub 合并状态 10 分钟仍未算出");
    });
  });
  test("only an unbroken streak counts: any other state in between restarts the clock", async () => {
    await with_("await_ci", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([pr({ checks: [{ name: "check", bucket: "pending" }] })], T0 + 5 * 60_000);
      await f.tick([computing()], T0 + 11 * 60_000);
      expect(f.state()).toEqual(WAITING("await_ci"));
      await f.tick([computing()], T0 + 21 * 60_000 - 1);
      expect(f.state()).toEqual(WAITING("await_ci"));
      await f.tick([computing()], T0 + 22 * 60_000);
      expect(f.state().run).toBe("unknown");
    });
  });
});

describe("i28-M12b gh pr checks: an empty answer is an empty list only while GitHub has no merge state yet", () => {
  const view = (mergeStateStatus: string) => JSON.stringify({ state: "OPEN", headRefOid: H, headRefName: `task/${ID}`, baseRefName: "main",
    isDraft: false, isCrossRepository: false, mergeStateStatus, mergeCommit: null });
  const inspect = (mergeState: string, checks: Awaited<ReturnType<typeof runBounded>>) => mergeExternal(config.projects.p!, async (argv) => {
    if (argv[1] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "", timedOut: false };
    if (argv[2] === "view") return { code: 0, stdout: view(mergeState), stderr: "", timedOut: false };
    return checks;
  }).inspect("https://github.com/example/repo/pull/42");
  const none = { code: 1, stdout: "", stderr: "no checks reported on the 'task/M12B' branch", timedOut: false };

  test("UNKNOWN / DIRTY with no checks → empty list", async () => {
    for (const s of ["UNKNOWN", "DIRTY"]) expect(await inspect(s, none)).toMatchObject({ mergeState: s, checks: [] });
  });
  test("other states with no checks, a timeout, or broken output still throw (→ unknown)", async () => {
    await expect(inspect("CLEAN", none)).rejects.toThrow(/gh pr checks 无结果/);
    await expect(inspect("BLOCKED", none)).rejects.toThrow(/gh pr checks 无结果/);
    await expect(inspect("UNKNOWN", { ...none, timedOut: true })).rejects.toThrow(/gh pr checks 无结果/);
    await expect(inspect("UNKNOWN", { code: 0, stdout: '[{"bucket":"weird"}]', stderr: "", timedOut: false })).rejects.toThrow(/输出无效/);
  });
  test("UNKNOWN with real checks parses them as before", async () => {
    const checks = [{ name: "check", bucket: "pending", link: "https://github.com/example/repo/actions/runs/1" }];
    expect((await inspect("UNKNOWN", { code: 8, stdout: JSON.stringify(checks), stderr: "", timedOut: false })).checks).toEqual(checks as PrSnapshot["checks"]);
  });
});
