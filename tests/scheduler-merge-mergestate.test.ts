/**
 * i28-M12b: right after main moves GitHub reports mergeStateStatus=UNKNOWN with no checks for a while. That is a wait,
 * not an unobservable result: the run stays in its phase (no unknown, no freeze) until GitHub decides, bounded by a limit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { closeLedger, getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { beginMergeRun, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { MERGE_STATE_UNKNOWN_LIMIT_MS, UNKNOWN_LIMIT_REASON, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { bounceReceipt, bounceReviewLine, bounceWork, fixBounce, parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { renderBouncePush } from "../src/lib/peer-pr-message.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

// Ids no other test file uses: the driver's UNKNOWN streak clock is per process and keyed by merge intent id.
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
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => 300 }) as Promise<Record<string, unknown>>;
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
  return { db, tick, state, close, calls, gh, external };
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
