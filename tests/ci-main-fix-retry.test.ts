/**
 * merge-arch-CIUNREL1: a red CI whose failing tests the PR never touched. The serial gate's layers record their verdicts in the
 * ledger (merge_ci_recovery_decision), CIF2's "main never changed the failing file" bounce registers a wait (ci_wait_main_fix), and
 * once main changes that file the scheduler retries once: a peer PR card gets one update-branch pinned to the registered head
 * (PEERHEAD1 takes the new head), a local card only a "would retry" sample. Fixture logs (PR1593's real shard, PR1598's shape),
 * a fake gh argv runner, a temporary ledger; no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { advanceMergeRun, getMergeRun } from "../src/lib/scheduler-merge.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { ciBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { bounceWork, fixBounce } from "../src/lib/scheduler-merge-conflict.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { recordObserved, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import { CI_MAIN_FIX_RETRY_KEY, configureRetryPolicy, WAIT_OP, WAIT_TTL_MS } from "../src/lib/ci-main-fix-retry.js";
import { ciDecisionClaim, DECISION_OP, DecisionTrail, decisionReceipt } from "../src/lib/ci-main-fix-retry-decision.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { ciMainFixRetryTick, retryGh, type RetryGh } from "../src/lib/ci-main-fix-retry-tick.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW = "a".repeat(40), PR = "https://github.com/example/repo/pull/7";
const RUN = "https://github.com/example/repo/actions/runs/77";
const BASE = "b".repeat(40), MAIN0 = "d".repeat(40), FIX = "f".repeat(40), OLD = "0".repeat(40);
const STALE = "tests/fix-strategy-remote-worker.test.ts";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const NOW = 200;

const at = (line: string) => `ci\tRun tests\t2026-10-16T00:00:03.1234567Z ${line}`;
/** PR1598's shape: one assertion (not a timeout) in a test file the PR does not touch. */
const PR1598 = [at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"), at(`##[group]${STALE}:`),
  at("error: expect(received).toBe(expected)"), at("(fail) remote worker > fix strategy [0.40ms]"), at("##[endgroup]"), at(""),
  at(" 1999 pass"), at(" 1 fail"), at("Ran 2000 tests across 300 files. [90.00s]"), at("##[error]Process completed with exit code 1.")].join("\n");
const PR1593 = readFileSync(join(import.meta.dir, "fixtures", "ci-log-timeout-pr1593-shard.txt"), "utf8");

interface Gh { log: string; files: string[]; compare: Record<string, string[]>; history: Record<string, string[]>; prHead: string; update: Error | null;
  argv: string[][]; rerun: number }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): BoundedResult => ({ code: 1, stdout: "", stderr, timedOut: false });
/** Answers gh argv like the real CLI would (post `--jq`). `compare[base]` = main's commits after `base`; `history[file]` = commits that changed it. */
const fakeGh = (gh: Gh) => async (argv: string[]): Promise<BoundedResult> => {
  gh.argv.push(argv);
  const cmd = argv.slice(1).join(" ");
  if (/^run view \d+ --repo example\/repo --json attempt,status,conclusion,headSha$/.test(cmd)) {
    return ok(JSON.stringify({ attempt: 1, status: "completed", conclusion: "failure", headSha: HEAD }));
  }
  if (/^run view \d+ --repo example\/repo --log-failed$/.test(cmd)) return ok(gh.log);
  if (/^run rerun \d+ --failed --repo example\/repo$/.test(cmd)) { gh.rerun++; return ok(""); }
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: gh.files.map((path) => ({ path })) }));
  const cmp = /^api repos\/example\/repo\/compare\/([a-f0-9]{40})\.\.\.main --jq /.exec(cmd);
  if (cmp) {
    const commits = gh.compare[cmp[1]!] ?? [];
    return ok(JSON.stringify({ base: cmp[1] === HEAD ? BASE : cmp[1], commits }));
  }
  const hist = /^api -X GET repos\/example\/repo\/commits -f sha=[a-f0-9]{40} -f path=(\S+) -F per_page=100 --jq /.exec(cmd);
  if (hist) return ok(JSON.stringify(gh.history[hist[1]!] ?? []));
  if (cmd === "api repos/example/repo/pulls/7 --jq .head.sha") return ok(`${gh.prHead}\n`);
  if (/^api -X PUT repos\/example\/repo\/pulls\/7\/update-branch -f expected_head_sha=[a-f0-9]{40}$/.test(cmd)) {
    if (gh.update) return no(gh.update.message);
    return ok(JSON.stringify({ message: "Updating pull request branch." }));
  }
  return no(`unexpected gh ${cmd}`);
};

const snap = (): PrSnapshot => ({ state: "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
  mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] });
const PEER = { peer: "hede", fp: "fp1", agent: "agent-a", login: "someone", url: PR, base: "main", number: 7 };

afterEach(() => configureRetryPolicy(null));
const policy = (mode: RecoveryMode) => configureRetryPolicy((_p, key) => ({ mode: key === CI_MAIN_FIX_RETRY_KEY ? mode : "off", manualAfterMs: null, source: "config" }));

/** The deploy kit's card back in `await_ci` on its reviewed head, red on run 77. `peer`: a peer PR card. */
function card(over: Partial<Gh> = {}, peer = false) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  if (peer) c.db.query("UPDATE tasks SET assigneeKind='peer_agent', assignee='fp1/agent-a', extra=? WHERE id='T9'").run(JSON.stringify({ peerPr: PEER }));
  const gh: Gh = { log: PR1598, files: ["src/lib/x.ts"], compare: { [HEAD]: [OLD, MAIN0] }, history: { [STALE]: [BASE] }, prHead: HEAD, update: null,
    argv: [], rerun: 0, ...over };
  const external = { inspect: async () => snap(), freshness: async () => ({ behindBy: 0, mainHead: MAIN0 }),
    carryReview: async () => { throw new Error("不该沿用"); }, updateBranch: async () => { throw new Error("不该走 gh pr update-branch"); },
    merge: async () => { throw new Error("不该合并"); }, ciRerun: ciRerunGh(fakeGh(gh) as never), ciBehind: ciBehindGh(fakeGh(gh) as never) } as MergeExternal;
  const tick = (now = NOW) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const notes = (op: string) => listEvents(c.db, { project: "p", target: "T9" }).filter((e) => e.kind === "note" && e.data.op === op);
  const samples = () => notes("recovery_observe").filter((e) => e.data.mechanism === CI_MAIN_FIX_RETRY_KEY);
  const stage = () => (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage;
  const updates = () => gh.argv.filter((a) => a.join(" ").includes("/update-branch"));
  const retry = (now = NOW + 1000) => ciMainFixRetryTick(c.db, ["p"], { gh: retryGh(fakeGh(gh) as never),
    record: async (a) => recordObserved(c.db, a, now), now: () => now });
  return { ...c, gh, tick, notes, samples, stage, updates, retry };
}
const withCard = async (over: Partial<Gh>, peer: boolean, body: (c: ReturnType<typeof card>) => Promise<void>) => {
  const c = card(over, peer);
  try { await body(c); } finally { c.close(); }
};
/** main after the registered main head: FIX, which changed the failing file. */
const mainFixed = (c: ReturnType<typeof card>) => { c.gh.compare[MAIN0] = [FIX]; c.gh.history[STALE] = [FIX, BASE]; };

describe("[验收线 1] PR1593's real log through the serial gate", () => {
  test("CIF1 re-runs it once, and the decision note says CIF1 accepted", async () => {
    policy("on");
    await withCard({ log: PR1593 }, false, async (c) => {
      await c.tick();
      expect(c.gh.rerun).toBe(1);
      expect(getMergeRun(c.db, c.intent)?.phase).toBe("await_ci");
      const [d, ...more] = c.notes(DECISION_OP);
      expect(more).toEqual([]);
      expect(d!.data.layers).toEqual([{ layer: "cif1", verdict: "accept", code: "accepted", why: expect.any(String) },
        { layer: "cif8", verdict: "not_reached", code: "not_reached", why: "" }, { layer: "cif2", verdict: "not_reached", code: "not_reached", why: "" }]);
      expect(d!.data.files).toEqual(["tests/lend-pr-takeover-preflight.test.ts"]);
    });
  });
});

describe("[验收线 2] every layer's refusal reaches the ledger once", () => {
  test("PR1598: CIF1 refuses a non-timeout, CIF2 refuses main-not-changed → exactly one decision with every layer's code", async () => {
    policy("on");
    await withCard({}, false, async (c) => {
      await c.tick();
      expect(c.stage()).toBe("fix");
      const [d, ...more] = c.notes(DECISION_OP);
      expect(more).toEqual([]);
      expect(d!.data).toMatchObject({ task: "T9", pr: PR, prHead: HEAD, run: RUN, attempt: 1, files: [STALE], budget: { rerun: 1, behind: 1 },
        switches: { ciMainFixRetry: "on" } });
      expect((d!.data.layers as { layer: string; verdict: string; code: string }[]).map((l) => [l.layer, l.verdict, l.code])).toEqual([
        ["cif1", "reject", "non_timeout"], ["cif8", "reject", "not_known_flaky"], ["cif2", "reject", "main_not_changed"]]);
      expect(String(d!.data.scope)).toContain("只核对了失败测试文件");
      await c.tick();
      await c.tick();
      expect(c.notes(DECISION_OP).length).toBe(1);
    });
  });

  test("the same run + attempt sent again (a re-tick before the bounce) writes nothing more and never moves the run", async () => {
    policy("on");
    await withCard({}, false, async (c) => {
      const t = new DecisionTrail();
      [t.run, t.attempt, t.files] = [RUN, 1, [STALE]];
      t.note("cif1", false, "有非超时失败：x");
      const receipt = decisionReceipt(HEAD, t)!;
      const sch = { actor: "scheduler", now: NOW };
      for (let i = 0; i < 2; i++) {
        const run = getMergeRun(c.db, c.intent)!;
        const after = advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: run.rev, receipt });
        expect([after.phase, after.rev]).toEqual(["await_ci", run.rev]);
      }
      expect(c.notes(DECISION_OP).length).toBe(1);
    });
  });
});

describe("[验收线 3] main fixed the failing file → one update-branch for a peer PR card", () => {
  test("bounce registers the wait; main changes the file; one tick sends one pinned update-branch; a moved head or a restart sends nothing more", async () => {
    policy("on");
    await withCard({}, true, async (c) => {
      await c.tick();
      expect(c.stage()).toBe("fix");
      const [reg, ...more] = c.notes(WAIT_OP);
      expect(more).toEqual([]);
      expect(reg!.data).toMatchObject({ task: "T9", pr: PR, prHead: HEAD, run: RUN, files: [STALE], mainHead: MAIN0, peer: true, mode: "on" });
      const bounce = fixBounce(listEvents(c.db, { project: "p", target: "T9" }), "fix")!;
      expect(bounce.waitMain).toBe("peer");
      expect(bounceWork(bounce).inputs).toContain("失败测试不在你的改动里，main 修好后系统会自动重试，你不用为这条改代码");
      expect(await c.retry()).toEqual([]);
      expect(c.updates()).toEqual([]); // main has not changed it yet
      mainFixed(c);
      expect(await c.retry()).toEqual([]);
      expect(c.updates()).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/7/update-branch", "-f", `expected_head_sha=${HEAD}`]]);
      expect(c.samples().map((s) => s.data)).toEqual([expect.objectContaining({ executed: true, peer: true, files: [STALE], prHead: HEAD,
        commits: { [STALE]: [FIX.slice(0, 12)] } })]);
      await c.retry(); // GitHub has not shown the new head yet: the sample stands for the one retry
      c.gh.prHead = NEW;
      await c.retry();
      await c.retry(NOW + 2000); // a restart reads the same ledger and the moved head
      expect(c.updates().length).toBe(1);
    });
  });

  test("GitHub refusing the pinned update (422, the head moved) is only logged", async () => {
    policy("on");
    await withCard({ update: new Error("HTTP 422: expected head sha didn't match current head ref") }, true, async (c) => {
      await c.tick();
      mainFixed(c);
      expect(await c.retry()).toEqual([]);
      expect(c.updates().length).toBe(1);
      await c.retry();
      expect(c.updates().length).toBe(1);
    });
  });
});

describe("[验收线 4] what must not be retried is not", () => {
  const registered = async (peer: boolean, body: (c: ReturnType<typeof card>) => Promise<void>) => {
    policy("on");
    await withCard({}, peer, async (c) => {
      await c.tick();
      expect(c.notes(WAIT_OP).length).toBe(1);
      mainFixed(c);
      await body(c);
    });
  };
  test("the author pushed a new head (GitHub, or the ledger) → no update-branch", async () => {
    await registered(true, async (c) => {
      c.gh.prHead = NEW;
      await c.retry();
      expect(c.updates()).toEqual([]);
      c.gh.prHead = HEAD;
      c.db.query("UPDATE tasks SET headSHA=? WHERE id='T9'").run(NEW);
      await c.retry();
      expect([c.updates(), c.samples()]).toEqual([[], []]);
    });
  });
  const holds: [string, (c: ReturnType<typeof card>) => void][] = [
    ["a frozen queue", (c) => c.db.query("INSERT OR REPLACE INTO meta (project, key, value) VALUES ('p', 'queueFrozen', ?)")
      .run(JSON.stringify({ frozen: true, reason: "test", since: 1 }))],
    ["an open ask", (c) => c.db.query(`INSERT INTO asks (id, project, taskId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('a1', 'p', 'T9', 'system', 'decide', 'q', 9e12, 'open', 1, 1)`).run()],
  ];
  for (const [name, hold] of holds) {
    test(`${name} → no update-branch`, async () => {
      await registered(true, async (c) => {
        hold(c);
        await c.retry();
        expect([c.updates(), c.samples()]).toEqual([[], []]);
      });
    });
  }
  test("a local (non-peer) card: only the would-retry sample, never update-branch; its author is told to merge main and deliver", async () => {
    await registered(false, async (c) => {
      const bounce = fixBounce(listEvents(c.db, { project: "p", target: "T9" }), "fix")!;
      expect(bounceWork(bounce).inputs).toContain("失败测试不在你的改动里，main 修好后 merge origin/main 重新交付即可，不用为这条改代码");
      await c.retry();
      await c.retry();
      expect(c.updates()).toEqual([]);
      expect(c.samples().map((s) => s.data.executed)).toEqual([false]);
    });
  });
  test("a registration older than 24 hours is skipped (read-only: nothing written)", async () => {
    await registered(true, async (c) => {
      const before = listEvents(c.db, { project: "p", target: "T9" }).length;
      await c.retry(NOW + WAIT_TTL_MS + 1);
      expect(c.updates()).toEqual([]);
      expect(listEvents(c.db, { project: "p", target: "T9" }).length).toBe(before);
    });
  });
  test("retried once and red again on the same files → bounced as usual, no new registration", async () => {
    await registered(true, async (c) => {
      await c.retry();
      expect(c.updates().length).toBe(1);
      // the new head's CI is red on the same file: the ledger-side registration refuses a file set already retried
      const t = new DecisionTrail();
      [t.run, t.attempt, t.files, t.mainHead] = ["https://github.com/example/repo/actions/runs/88", 1, [STALE], FIX];
      t.note("cif2", false, `main 在 merge-base 之后没改过 ${STALE}`);
      const row = { ...getMergeRun(c.db, c.intent)!, phase: "await_ci" as const }; // the next merge run's red, read in its transaction
      c.db.transaction(() => ciDecisionClaim(c.db, { actor: "scheduler", now: NOW }, row, decisionReceipt(HEAD, t)!, null,
        () => ({ rerun: false, behind: false }), insertEvent))();
      expect(c.notes(DECISION_OP).length).toBe(2);
      expect(c.notes(WAIT_OP).length).toBe(1);
    });
  });
});

describe("[验收线 4][验收线 5] authority is read again after every await before update-branch", () => {
  const freeze = (c: ReturnType<typeof card>, frozen: boolean) => c.db.query("INSERT OR REPLACE INTO meta (project, key, value) VALUES ('p', 'queueFrozen', ?)")
    .run(JSON.stringify({ frozen, reason: "test", since: 1 }));
  /** A tick whose GitHub file read (`during: "read"`) or sample write (`during: "record"`) lets `change` land at that await. */
  const racing = (c: ReturnType<typeof card>, during: "read" | "record", change: () => void, now = NOW + 1000) => {
    const gh = retryGh(fakeGh(c.gh) as never);
    const raced: RetryGh = { ...gh, fileCommits: async (...a) => { const r = await gh.fileCommits(...a); if (during === "read") change(); return r; } };
    return ciMainFixRetryTick(c.db, ["p"], { gh: raced, now: () => now,
      record: async (a) => { const r = recordObserved(c.db, a, now); if (during === "record" && a.actionKey.startsWith("retry:")) change(); return r; } });
  };
  const registered = async (body: (c: ReturnType<typeof card>) => Promise<void>) => {
    policy("on");
    await withCard({}, true, async (c) => {
      await c.tick();
      expect(c.notes(WAIT_OP).length).toBe(1);
      mainFixed(c);
      await body(c);
    });
  };
  for (const during of ["read", "record"] as const) {
    test(`a queue freeze during the ${during} → no update-branch; once thawed, exactly one`, async () => {
      await registered(async (c) => {
        expect(await racing(c, during, () => freeze(c, true))).toEqual([]);
        expect(c.updates()).toEqual([]);
        await c.retry();
        expect(c.updates()).toEqual([]);
        freeze(c, false);
        await c.retry();
        await c.retry();
        expect(c.updates().length).toBe(1);
        expect(c.samples().filter((s) => s.data.executed === true).length).toBe(during === "record" ? 2 : 1);
      });
    });
    test(`the switch rolled back to off during the ${during} → no update-branch`, async () => {
      await registered(async (c) => {
        await racing(c, during, () => policy("off"));
        expect(c.updates()).toEqual([]);
        await c.retry();
        expect(c.updates()).toEqual([]);
      });
    });
    test(`the switch moved to observe during the ${during} → no update-branch, only the would-retry sample`, async () => {
      await registered(async (c) => {
        await racing(c, during, () => policy("observe"));
        await c.retry();
        expect(c.updates()).toEqual([]);
        expect(c.samples().some((s) => s.data.executed === false && !s.data.released)).toBe(true);
      });
    });
    test(`an open ask or the card leaving fix during the ${during} → no update-branch`, async () => {
      await registered(async (c) => {
        await racing(c, during, () => c.db.query(`INSERT INTO asks (id, project, taskId, source, kind, title, expiresAt, state, createdAt, updatedAt)
          VALUES ('a1', 'p', 'T9', 'system', 'decide', 'q', 9e12, 'open', 1, 1)`).run());
        expect(c.updates()).toEqual([]);
        c.db.query("UPDATE asks SET state='answered' WHERE id='a1'").run();
        await racing(c, during, () => c.db.query("UPDATE tasks SET stage='merge' WHERE id='T9'").run());
        await c.retry();
        expect(c.updates()).toEqual([]);
      });
    });
  }
  test("a released sample is not a retry: the same file set is still registered after a later red", async () => {
    await registered(async (c) => {
      await racing(c, "record", () => freeze(c, true));
      expect(c.samples().map((s) => [s.data.executed, s.data.released ?? null])).toEqual([[true, null], [false, `retry:${HEAD}:77`]]);
      const { retriedFiles } = await import("../src/lib/ci-main-fix-retry.js");
      expect(retriedFiles(c.db, "T9")).toEqual([]);
    });
  });
});

describe("[验收线 5] the ciMainFixRetry switch", () => {
  test("unset → on (OBSGATE1 new-key rule)", () => {
    expect(defaultRecoveryMode(CI_MAIN_FIX_RETRY_KEY)).toBe("on");
  });
  test("observe: registers and samples 'would retry', never update-branch", async () => {
    policy("observe");
    await withCard({}, true, async (c) => {
      await c.tick();
      expect(c.notes(WAIT_OP).map((e) => e.data.mode)).toEqual(["observe"]);
      expect(fixBounce(listEvents(c.db, { project: "p", target: "T9" }), "fix")!.waitMain).toBe("local"); // no automatic retry promised
      mainFixed(c);
      await c.retry();
      expect(c.updates()).toEqual([]);
      expect(c.samples().map((s) => s.data.executed)).toEqual([false]);
    });
  });
  test("off: no registration, the fix order as before, the tick does nothing", async () => {
    policy("off");
    await withCard({}, true, async (c) => {
      await c.tick();
      expect(c.stage()).toBe("fix");
      expect(c.notes(WAIT_OP)).toEqual([]);
      const bounce = fixBounce(listEvents(c.db, { project: "p", target: "T9" }), "fix")!;
      expect(bounce.waitMain).toBeUndefined();
      expect(bounceWork(bounce).inputs.length).toBe(1);
      mainFixed(c);
      await c.retry();
      expect([c.updates(), c.samples()]).toEqual([[], []]);
      expect(c.gh.argv.filter((a) => a.join(" ").includes("pulls/7 --jq"))).toEqual([]);
    });
  });
});
