/**
 * merge-arch-CIMAINSRC1 · the scheduler flow: a red PR whose every failure is failing on main the same way stays in the merge
 * recovery path (no bounce, no author, no reviewer) with the evidence and the main fix owner registered; main's CI turning green,
 * or the registered main-red-fix card merging, earns one update-branch pinned to the reviewed head even though main never touched
 * the failing test file. Anything else keeps the old bounce, and with the switch off the run is the old one call for call.
 * Fixture logs, fake gh ports, the deploy kit's ledger; no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { ciBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { CI_MAIN_SOURCE_WAIT_KEY, configureSourceWaitPolicy, forgetSourceWait, RETRY_OP, VERDICT_OP, type MainRun, type MainSourceGh } from "../src/lib/ci-main-source-wait.js";
import { WAIT_OP } from "../src/lib/ci-main-fix-retry.js";
import { NODE_OP } from "../src/lib/main-red-fix.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW = "a".repeat(40), PR = "https://github.com/example/repo/pull/7";
const RUN = "https://github.com/example/repo/actions/runs/77", RUN2 = "https://github.com/example/repo/actions/runs/78";
const BASE = "b".repeat(40), FIX = "f".repeat(40), OLD = "0".repeat(40), MAIN_RED = "e".repeat(40), MAIN_GREEN = "d".repeat(40);
const MAIN_RUN = "https://github.com/example/repo/actions/runs/900";
const STALE = "tests/lend-claude-capacity.test.ts";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

const at = (line: string) => `ci\tRun tests\t2026-10-17T01:02:03.1234567Z ${line}`;
const ciLog = (error: string) => [at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"), at(`##[group]${STALE}:`), at(error),
  at("(fail) capacity > 窗口未过期 [0.40ms]"), at("##[endgroup]"), at(""), at(" 1999 pass"), at(" 1 fail"), at("Ran 2000 tests across 300 files. [90.00s]"),
  at("##[error]Process completed with exit code 1.")].join("\n");
/** An assertion, not a timeout: CIF1 bounces; main never changed the test file, so CIF2 bounces too (the case CIF2's retry misses). */
const RED = ciLog("error: expect(received).toBeGreaterThan(expected)");
const OTHER = ciLog("error: expect(received).toBe(expected)");
const TYPECHECK = [at("src/lib/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."), at("##[error]Process completed with exit code 2.")].join("\n");

interface World { mainRuns: MainRun[]; mainLog: string; argv: string[][]; mainCalls: string[] }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): BoundedResult => ({ code: 1, stdout: "", stderr, timedOut: false });
const mainRun = (id: number, headSha: string, conclusion: string, status = "completed"): MainRun =>
  ({ id, attempt: 1, headSha, status, conclusion, url: `https://github.com/example/repo/actions/runs/${id}`, createdAt: id * 1000 });
const snapOf = (head: string, bucket: "fail" | "pending", link = RUN): PrSnapshot => ({ state: "OPEN", head, branch: "feat/t9", base: "main",
  draft: false, crossRepository: false, mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket, link: `${link}/job/9` }] });
const CARRY = { ok: true, reason: "净 diff 一致", mainParent: FIX, mainHead: FIX, diffHash: "9".repeat(64) };

function card(opts: { port?: boolean } = {}) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  let snap = snapOf(HEAD, "fail");
  const w: World = { mainRuns: [mainRun(900, MAIN_RED, "failure")], mainLog: RED, argv: [], mainCalls: [] };
  const fakeGh = async (argv: string[]): Promise<BoundedResult> => {
    w.argv.push(argv);
    const cmd = argv.slice(1).join(" ");
    if (/^run view \d+ --repo example\/repo --json attempt,status,conclusion,headSha$/.test(cmd)) {
      return ok(JSON.stringify({ attempt: 1, status: "completed", conclusion: "failure", headSha: snap.head }));
    }
    if (/^run view \d+ --repo example\/repo --log-failed$/.test(cmd)) return ok(RED);
    if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: [{ path: "src/lib/x.ts" }] }));
    if (/^api repos\/example\/repo\/compare\/[a-f0-9]{40}\.\.\.main --jq /.test(cmd)) return ok(JSON.stringify({ base: BASE, commits: [OLD, FIX] }));
    if (/^api -X GET repos\/example\/repo\/commits /.test(cmd)) return ok(JSON.stringify([BASE])); // main never touched the test file
    if (/^api -X PUT repos\/example\/repo\/pulls\/7\/update-branch -f expected_head_sha=[a-f0-9]{40}$/.test(cmd)) { snap = snapOf(NEW, "pending"); return ok("{}"); }
    return no(`unexpected gh ${cmd}`);
  };
  const ciMainSource: MainSourceGh = {
    mainRuns: async () => { w.mainCalls.push("runs"); return w.mainRuns; },
    failedLog: async (_repo, id) => { w.mainCalls.push(`log ${id}`); return w.mainLog; },
  };
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: FIX }),
    carryReview: async (_pr: string, previousHead: string, head: string) => ({ ...CARRY, chain: [{ previousHead, head, mainParent: FIX }] }),
    updateBranch: async () => { throw new Error("不该走 gh pr update-branch"); }, merge: async () => { throw new Error("不该合并"); },
    ciRerun: ciRerunGh(fakeGh as never), ciBehind: ciBehindGh(fakeGh as never), ...(opts.port === false ? {} : { ciMainSource }) } as MergeExternal;
  const calls: string[][] = [];
  const manager = (now: number) => async (...args: string[]) => { calls.push(args); return ledgerAs(c.db, "scheduler", () => now)(...args); };
  const tick = (now = 200) => schedulerMergeTick(c.db, config, manager(now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined,
    stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  const notes = (op: string) => (c.db.query(`SELECT text, data FROM events WHERE target='T9' AND kind IN ('note','scheduler')
    AND json_extract(data,'$.op')=? ORDER BY seq`).all(op) as { text: string; data: string }[]).map((e) => ({ text: e.text, ...JSON.parse(e.data) }));
  const updates = () => w.argv.filter((a) => a.join(" ").includes("/update-branch"));
  const dispatches = () => (c.db.query("SELECT COUNT(*) AS n FROM events WHERE target='T9' AND kind IN ('dispatch','stage')").get() as { n: number }).n;
  return { ...c, w, tick, state, notes, updates, dispatches, calls, setSnap: (s: PrSnapshot) => { snap = s; } };
}
type Card = ReturnType<typeof card>;
const withCard = async (body: (c: Card) => Promise<void>, opts?: { port?: boolean }) => {
  const c = card(opts);
  try { await body(c); } finally { c.close(); }
};
const policy = (mode: RecoveryMode) => configureSourceWaitPolicy((_p, key) => ({ mode: key === CI_MAIN_SOURCE_WAIT_KEY ? mode : "off", manualAfterMs: null,
  source: "config" }));
afterEach(() => { configureSourceWaitPolicy(null); forgetSourceWait(); });
const WAITING = { run: "await_ci", stage: "merge" }, BOUNCED = { run: "resolved", stage: "fix" };
const sourceRegs = (c: Card) => c.notes(WAIT_OP).filter((n) => n.source === CI_MAIN_SOURCE_WAIT_KEY);
/** The main-red-fix node for main run 900 and its card, merged into main when `merged`. */
function fixCard(c: Card, merged: boolean) {
  insertEvent(c.db, { actor: "scheduler", now: 150 }, { project: "p", target: "", kind: "scheduler", text: "main CI 红：写了修复节点",
    data: { op: NODE_OP, source: "mainRedFix", workflow: "push", checks: ["ci"], featureId: "merge-arch", key: "MAINRED9", taskId: "FIX9", runId: 900, mainSha: MAIN_RED } }, false);
  if (!merged) return;
  c.db.run("PRAGMA foreign_keys = OFF"); // the fix card's own task and intent are not part of this world
  c.db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, rev, mergeSha,
    reason, createdAt, updatedAt) VALUES ('mfix', 'FIX9', 'p', 'https://github.com/example/repo/pull/8', 'fix/9', ?, 'ci', 'merged', 4, ?, NULL, 160, 160)`)
    .run("1".repeat(40), "2".repeat(40));
  c.db.run("PRAGMA foreign_keys = ON");
}

describe("[验收线 1] same red on main: the card stays in the merge recovery path", () => {
  test("every failure has main's triple → run untouched, no bounce, no author or reviewer, evidence + owner registered", async () => {
    policy("on");
    await withCard(async (c) => {
      fixCard(c, false);
      const before = c.dispatches();
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      expect(c.notes("merge_conflict")).toEqual([]);
      expect(c.dispatches()).toBe(before);
      const [reg, ...more] = sourceRegs(c);
      expect(more).toEqual([]);
      expect(reg).toMatchObject({ intentId: c.intent, prHead: HEAD, run: RUN, attempt: 1, checks: ["ci"], files: [STALE], mainHead: MAIN_RED, mainRun: MAIN_RUN,
        mainAttempt: 1, mainNewest: MAIN_RED, matches: [[STALE, "capacity > 窗口未过期", "error: expect(received).toBeGreaterThan(expected)"]],
        owner: { kind: "main_red_fix", card: "FIX9", node: "merge-arch/MAINRED9" } });
      expect(typeof reg.sampledAt).toBe("number");
      expect(reg.text).toContain("修复卡 FIX9");
      // more passes while main stays red: still waiting, one registration, never an update-branch, no layer re-read
      const argv = c.w.argv.length;
      await c.tick();
      await c.tick();
      expect([c.state(), sourceRegs(c).length, c.updates()]).toEqual([WAITING, 1, []]);
      expect(c.w.argv.slice(argv).filter((a) => a.includes("compare") || a.join(" ").includes("pr view"))).toEqual([]);
    });
  });

  test("any failure without main's triple (other fingerprint, main log forms no triples, main CI green) → the old bounce, nothing registered", async () => {
    policy("on");
    for (const set of [(w: World) => { w.mainLog = OTHER; }, (w: World) => { w.mainLog = TYPECHECK; },
      (w: World) => { w.mainRuns = [mainRun(900, MAIN_RED, "success")]; }, (w: World) => { w.mainRuns = [mainRun(900, MAIN_RED, "failure", "in_progress")]; }]) {
      forgetSourceWait();
      await withCard(async (c) => {
        set(c.w);
        await c.tick();
        expect(c.state()).toEqual(BOUNCED);
        expect(sourceRegs(c)).toEqual([]);
        expect(c.notes("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", checks: [{ name: "ci", link: RUN }] })]);
      });
    }
  });
});

describe("[验收线 2] main fixed only the implementation: one update-branch, CI runs again", () => {
  test("main CI green on a newer head (test file never changed on main) → one update-branch pinned to the reviewed head; a re-send never repeats it", async () => {
    policy("on");
    await withCard(async (c) => {
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      c.w.mainRuns = [mainRun(900, MAIN_RED, "failure"), mainRun(901, MAIN_GREEN, "success")];
      await c.tick();
      expect(c.state()).toEqual({ run: "updating", stage: "merge" });
      expect(c.updates()).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/7/update-branch", "-f", `expected_head_sha=${HEAD}`]]);
      expect(c.notes(RETRY_OP)).toEqual([expect.objectContaining({ trigger: "main_green", sha: MAIN_GREEN, prHead: HEAD, mainRun: "https://github.com/example/repo/actions/runs/901" })]);
      expect(c.notes("merge_ci_behind")).toEqual([expect.objectContaining({ from: "await_ci", to: "updating", oldHead: HEAD, files: { [STALE]: [MAIN_GREEN.slice(0, 12)] } })]);
      // the new head is carried (pure main merge, the review stands) and the merge gate waits for its own CI
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      expect(getMergeRun(c.db, c.intent)?.reviewedHead).toBe(NEW);
      await c.tick();
      expect([c.state(), c.updates().length, c.notes(RETRY_OP).length]).toEqual([WAITING, 1, 1]);
    });
  });

  test("restart while the update is claimed but GitHub still shows the old head: the claim is re-read, update-branch is not sent again", async () => {
    policy("on");
    await withCard(async (c) => {
      await c.tick();
      c.w.mainRuns = [mainRun(901, MAIN_GREEN, "success")];
      c.setSnap(snapOf(HEAD, "fail")); // GitHub keeps the old head for a moment
      await c.tick();
      c.setSnap(snapOf(HEAD, "fail"));
      forgetSourceWait(); // the scheduler restarts
      await c.tick();
      await c.tick();
      expect([c.state(), c.updates().length, c.notes(RETRY_OP).length]).toEqual([{ run: "updating", stage: "merge" }, 1, 1]);
    });
  });

  test("the registered fix card merged into main while main's CI is still red → the same one update-branch", async () => {
    policy("on");
    await withCard(async (c) => {
      fixCard(c, false);
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      fixCard(c, true);
      await c.tick();
      expect(c.updates()).toHaveLength(1);
      expect(c.notes(RETRY_OP)).toEqual([expect.objectContaining({ trigger: "fix_merged", card: "FIX9", sha: "2".repeat(40) })]);
    });
  });
});

describe("[验收线 3] no false trigger, and no merge on a retry that is still red", () => {
  test("main still red (even a newer red), no fix card merged → wait, never an update-branch", async () => {
    policy("on");
    await withCard(async (c) => {
      fixCard(c, false);
      await c.tick();
      c.w.mainRuns = [mainRun(900, MAIN_RED, "failure"), mainRun(902, MAIN_GREEN, "failure")];
      await c.tick();
      c.w.mainRuns = [mainRun(902, MAIN_GREEN, "failure"), mainRun(903, MAIN_GREEN, "success", "in_progress")];
      await c.tick();
      expect([c.state(), c.updates(), c.notes(RETRY_OP)]).toEqual([WAITING, [], []]);
    });
  });

  test("evidence breaks while waiting (main log unreadable) → keep waiting, no trigger, no bounce", async () => {
    policy("on");
    await withCard(async (c) => {
      await c.tick();
      c.w.mainLog = TYPECHECK;
      c.w.mainRuns = [mainRun(904, MAIN_RED, "failure")];
      await c.tick();
      expect([c.state(), c.updates()]).toEqual([WAITING, []]);
    });
  });

  test("the author pushed a new head while waiting → re-review as before, main turning green sends nothing", async () => {
    policy("on");
    await withCard(async (c) => {
      await c.tick();
      c.setSnap(snapOf(NEW, "pending"));
      c.w.mainRuns = [mainRun(901, MAIN_GREEN, "success")];
      await c.tick();
      expect([getMergeRun(c.db, c.intent)?.phase, c.updates(), c.notes(RETRY_OP)]).toEqual(["await_review", [], []]);
    });
  });

  test("the card paused (workflow manual) while waiting → no update-branch", async () => {
    policy("on");
    await withCard(async (c) => {
      await c.tick();
      c.db.query("UPDATE task_workflows SET mode = 'manual', rev = rev + 1 WHERE taskId = 'T9'").run();
      c.w.mainRuns = [mainRun(901, MAIN_GREEN, "success")];
      await c.tick();
      expect([c.updates(), c.notes(RETRY_OP)]).toEqual([[], []]);
      expect(c.state().stage).toBe("merge");
    });
  });

  test("the retried head is red again (still main's red) → not merged: back to fix as before, the verdict recorded", async () => {
    policy("on");
    await withCard(async (c) => {
      await c.tick();
      c.w.mainRuns = [mainRun(901, MAIN_GREEN, "success")];
      await c.tick();
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      c.setSnap(snapOf(NEW, "fail", RUN2));
      c.w.mainRuns = [mainRun(905, MAIN_GREEN, "failure")];
      await c.tick();
      expect([c.state(), c.updates().length]).toEqual([BOUNCED, 1]);
      expect(c.notes(VERDICT_OP)).toEqual([expect.objectContaining({ outcome: "retry_red", prHead: NEW, run: RUN2, matched: true })]);
      expect(c.notes("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: NEW })]);
    });
  });
});

describe("[验收线 4] switch off: the old path, call for call", () => {
  /** Ledger calls, gh argv, stage events and the merge_conflict receipt of one red tick. */
  const trace = async (opts: { port?: boolean }) => {
    let out: unknown;
    forgetSourceWait();
    await withCard(async (c) => {
      await c.tick();
      out = { calls: c.calls, argv: c.w.argv, mainCalls: c.w.mainCalls, state: c.state(), reason: getMergeRun(c.db, c.intent)?.reason,
        stages: (c.db.query("SELECT data FROM events WHERE target='T9' AND kind='stage' ORDER BY seq").all() as { data: string }[]).map((e) => JSON.parse(e.data)),
        conflict: c.notes("merge_conflict").map(({ text, cause, checks, count }) => ({ text, cause, checks, count })), regs: sourceRegs(c) };
    }, opts);
    return out as { calls: string[][]; mainCalls: string[]; state: unknown; reason: string; regs: unknown[] };
  };

  test("off with the main port present = no port at all (the code before this card): same receipts, transitions and external calls", async () => {
    policy("off");
    const off = await trace({});
    const before = await trace({ port: false });
    expect(off).toEqual(before);
    expect(off.mainCalls).toEqual([]);
    expect(off.regs).toEqual([]);
    expect(off.state).toEqual(BOUNCED);
    expect(off.reason).toBe(`ci_fail: 退回 fix（ci_fail）：PR head ${HEAD}，失败检查 ${JSON.stringify([{ name: "ci", link: RUN }])}`);
    expect(off.calls.filter((a) => a.includes("--receipt")).map((a) => a[a.indexOf("--receipt") + 1]).at(-1))
      .toBe(`退回 fix（ci_fail）：PR head ${HEAD}，失败检查 ${JSON.stringify([{ name: "ci", link: RUN }])}`);
  });

  test("observe: one sample of what on would do, then the same bounce as off", async () => {
    policy("observe");
    await withCard(async (c) => {
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(sourceRegs(c)).toEqual([]);
      expect(c.notes("recovery_observe")).toEqual([expect.objectContaining({ mechanism: CI_MAIN_SOURCE_WAIT_KEY, prHead: HEAD, run: RUN, mainRun: MAIN_RUN })]);
    });
  });
});
