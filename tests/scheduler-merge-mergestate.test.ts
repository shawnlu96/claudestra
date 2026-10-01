/**
 * i28-M12b: right after main moves GitHub reports mergeStateStatus=UNKNOWN with no checks for a while. That is a wait,
 * not an unobservable result: the run stays in its phase (no unknown, no freeze) until GitHub decides, bounded by a limit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { closeLedger, getMeta, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { beginMergeRun, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { MERGE_STATE_UNKNOWN_LIMIT_MS, UNKNOWN_LIMIT_REASON, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

// Ids no other test file uses: the driver's UNKNOWN streak clock is per process and keyed by merge intent id.
const ID = "M12B", INTENT = `merge-${ID}`;
const H = "a".repeat(40), MAIN = "e".repeat(40), M = "b".repeat(40);
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
  let snaps: PrSnapshot[] = [pr()];
  const external: MergeExternal = {
    inspect: async () => snaps.length > 1 ? snaps.shift()! : snaps[0]!,
    freshness: async () => ({ behindBy: 0, mainHead: MAIN }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => {},
    merge: async () => M,
  };
  const manager = async (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"],
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => 300 }) as Promise<Record<string, unknown>>;
  /** One scheduler tick at wall clock `at`, with GitHub answering `next`. */
  const tick = async (next: PrSnapshot[], at?: number) => {
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
  return { db, tick, state, close };
}
type F = ReturnType<typeof fixture>;
const with_ = async (phase: MergePhase, body: (f: F) => Promise<void>) => {
  const f = fixture(phase);
  try { await body(f); } finally { f.close(); }
};
afterEach(() => { setSystemTime(); });

const T0 = Date.UTC(2026, 9, 2, 1, 11);
const WAITING = (run: string) => ({ run, stage: "merge", frozen: false });

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

describe("i28-M12b the UNKNOWN wait is bounded", () => {
  test(`UNKNOWN for more than ${MERGE_STATE_UNKNOWN_LIMIT_MS / 60_000} minutes → unknown with a readable reason`, async () => {
    await with_("await_ci", async (f) => {
      await f.tick([computing()], T0);
      await f.tick([computing()], T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
      expect(f.state()).toEqual(WAITING("await_ci"));
      await f.tick([computing()], T0 + MERGE_STATE_UNKNOWN_LIMIT_MS + 1);
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
      await f.tick([computing()], T0 + 21 * 60_000);
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
