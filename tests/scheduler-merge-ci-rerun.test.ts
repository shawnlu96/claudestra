/**
 * i28-CIF1: red required CI that only timed out in tests the PR does not touch is re-run once per head instead of bouncing
 * to fix; every other red (or any doubt) still bounces. Fixture logs and a fake gh argv runner, no network.
 */
import { describe, expect, test } from "bun:test";
import { getMergeRun, advanceMergeRun } from "../src/lib/scheduler-merge.js";
import { bounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { ciRerunGh, parseRerunReceipt, RERUN_SETTLE_MS, RERUN_WAIT, rerunReceipt } from "../src/lib/scheduler-merge-ci-rerun.js";
import { parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), PR = "https://github.com/example/repo/pull/7", RUN = "https://github.com/example/repo/actions/runs/77";
const SLOW = "tests/local-api-last-seen.test.ts";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

const at = (line: string) => `ci\tRun tests\t2026-10-02T11:02:03.1234567Z ${line}`;
const ciLog = (body: string[], fails = 1) => [
  at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"),
  ...body, at(""), at(" 1999 pass"), at(` ${fails} fail`), at("Ran 2000 tests across 300 files. [90.00s]"),
  at("##[error]Process completed with exit code 1."),
].join("\n");
const TIMEOUT_ONLY = ciLog([at(`##[group]${SLOW}:`), at("(fail) 本机 API last-seen > 过滤在 LIMIT 之前 [6189.00ms]"),
  at("  ^ this test timed out after 5000ms."), at("##[endgroup]")]);
const WITH_ASSERT = ciLog([at(`##[group]${SLOW}:`), at("(fail) 本机 API last-seen > 过滤在 LIMIT 之前 [6189.00ms]"),
  at("  ^ this test timed out after 5000ms."), at("##[endgroup]"), at("##[group]tests/b.test.ts:"), at("error: expect(received).toBe(expected)"),
  at("(fail) b > 断言 [0.40ms]"), at("##[endgroup]")], 2);

/** `lag`: the rerun call succeeds but run view keeps showing the old attempt (GitHub's eventual consistency). */
interface Gh { attempt: number; status: string; conclusion: string; log: string | Error; files: string[]; rerun: Error | null; lag: boolean;
  argv: string[][] }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): BoundedResult => ({ code: 1, stdout: "", stderr, timedOut: false });
/** Answers gh argv like the real CLI would for run 77 / PR 7. */
const fakeGh = (gh: Gh) => async (argv: string[]): Promise<BoundedResult> => {
  gh.argv.push(argv);
  const cmd = argv.slice(1).join(" ");
  if (cmd === "run view 77 --repo example/repo --json attempt,status,conclusion") {
    return ok(JSON.stringify({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion }));
  }
  if (cmd === "run view 77 --repo example/repo --log-failed") return gh.log instanceof Error ? no(gh.log.message) : ok(gh.log);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: gh.files.map((path) => ({ path, additions: 1, deletions: 0 })) }));
  if (cmd === "run rerun 77 --failed --repo example/repo") {
    if (gh.rerun) return no(gh.rerun.message);
    if (gh.lag) return ok("");
    gh.attempt++;
    gh.status = "queued";
    gh.conclusion = "";
    return ok("");
  }
  return no(`unexpected gh ${cmd}`);
};

const red = (): PrSnapshot => ({ state: "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
  mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] });

/** The deploy kit's card, put back to `await_ci` on its reviewed head before any merge was sent. */
function card(over: Partial<Gh> = {}) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  const gh: Gh = { attempt: 1, status: "completed", conclusion: "failure", log: TIMEOUT_ONLY, files: ["src/lib/x.ts", "tests/x.test.ts"],
    rerun: null, lag: false, argv: [], ...over };
  let snap = red();
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => {}, merge: async () => { throw new Error("不该合并"); },
    ciRerun: ciRerunGh(fakeGh(gh) as never) } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined, stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  const events = (op: string) => (c.db.query(`SELECT text, data FROM events WHERE target='T9' AND kind='scheduler' AND json_extract(data,'$.op')=?
    ORDER BY seq`).all(op) as { text: string; data: string }[]).map((e) => ({ text: e.text, ...JSON.parse(e.data) }));
  const reruns = () => gh.argv.filter((a) => a[1] === "run" && a[2] === "rerun").length;
  return { ...c, gh, tick, state, events, reruns, setSnap: (s: PrSnapshot) => { snap = s; } };
}
const withCard = async (over: Partial<Gh>, body: (c: ReturnType<typeof card>) => Promise<void>) => {
  const c = card(over);
  try { await body(c); } finally { c.close(); }
};
const BOUNCED = { run: "resolved", stage: "fix" };

describe("i28-CIF1 merge gate re-runs CI that only timed out in tests the PR did not touch", () => {
  test("timeouts only, files outside the PR → one rerun --failed, the run keeps waiting, an event names reason, cases and run", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
      expect(c.reruns()).toBe(1);
      expect(c.events("merge_conflict")).toEqual([]);
      const [ev, ...more] = c.events("merge_ci_rerun");
      expect(more).toEqual([]);
      expect(ev).toMatchObject({ prHead: HEAD, run: RUN, checks: ["ci"], cases: [`${SLOW} > 本机 API last-seen > 过滤在 LIMIT 之前`] });
      expect(ev.reason).toContain("超时");
      expect(ev.text).toContain(RUN);
      // The rerun is still going while GitHub shows the old red: keep waiting, never a second rerun.
      c.gh.status = "in_progress";
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([{ run: "await_ci", stage: "merge" }, 1]);
      // Rerun went green: the gate merges as usual (the fake merge refuses, which only proves it got that far).
      c.setSnap({ ...red(), mergeState: "CLEAN", checks: [{ name: "ci", bucket: "pass" }] });
      await c.tick();
      expect(c.state().run).toBe("unknown");
    });
  });

  test("the timed-out file is in the PR, or an assertion failed too → back to fix at once, no rerun", async () => {
    for (const over of [{ files: [SLOW] }, { log: WITH_ASSERT }]) {
      await withCard(over, async (c) => {
        await c.tick();
        expect(c.state()).toEqual(BOUNCED);
        expect(c.reruns()).toBe(0);
        expect(c.events("merge_ci_rerun")).toEqual([]);
        expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", checks: [{ name: "ci", link: RUN }] })]);
      });
    }
  });

  test("same head still red after the rerun → back to fix, never a second rerun", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      c.gh.status = "completed";
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(c.reruns()).toBe(1);
      expect(c.events("merge_conflict")).toHaveLength(1);
    });
  });

  test("rerun accepted but GitHub still shows attempt 1 completed → keep waiting, no second rerun; green run with stale red checks waits too", async () => {
    await withCard({ lag: true }, async (c) => {
      await c.tick();
      for (let i = 0; i < 2; i++) {
        await c.tick();
        expect([c.state(), c.reruns()]).toEqual([{ run: "await_ci", stage: "merge" }, 1]);
      }
      expect(c.events("merge_ci_rerun")).toHaveLength(1);
      expect(c.events("merge_conflict")).toEqual([]);
      // The second attempt ended green while the PR still shows the old red: wait for the checks, do not bounce.
      Object.assign(c.gh, { attempt: 2, status: "completed", conclusion: "success" });
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([{ run: "await_ci", stage: "merge" }, 1]);
      // It ended red instead: that is the second red on this head.
      c.gh.conclusion = "failure";
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
    });
  });

  test("a claimed rerun that never shows up on GitHub within the settle window → back to fix, still one rerun", async () => {
    await withCard({ lag: true }, async (c) => {
      const t0 = 200;
      await c.tick(t0);
      await c.tick(t0 + RERUN_SETTLE_MS - 1);
      expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
      await c.tick(t0 + RERUN_SETTLE_MS);
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
    });
  });

  test("ledger: a second rerun claim on the same head becomes the ci_fail bounce, whatever the driver read", async () => {
    await withCard({}, async (c) => {
      const receipt = rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases: ["tests/x.test.ts > slow"] });
      const sch = { actor: "scheduler", now: 500 };
      const first = advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 4, receipt });
      expect([first.phase, first.rev]).toEqual(["await_ci", 5]);
      const settling = advanceMergeRun(c.db, { ...sch, now: 600 }, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 5, receipt });
      expect([settling.phase, settling.rev]).toEqual(["await_ci", 5]);
      const other = rerunReceipt(HEAD, { link: "https://github.com/example/repo/actions/runs/78", checks: ["ci"], cases: [] });
      const again = advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 5, receipt: other });
      expect(again.phase).toBe("resolved");
      expect(c.state()).toEqual(BOUNCED);
      expect(c.events("merge_ci_rerun")).toHaveLength(1);
    });
  });

  test("fail-closed: log fetch fails, log does not parse, run already re-run by hand, or the rerun call fails → back to fix", async () => {
    const cases: [Partial<Gh>, number][] = [[{ log: new Error("HTTP 404") }, 0], [{ log: "garbage\nno tests here" }, 0],
      [{ log: ciLog([at(`##[group]${SLOW}:`), at("(fail) slow [6000.00ms]"), at("  ^ this test timed out after 5000ms."), at("##[endgroup]")], 2) }, 0],
      [{ attempt: 2 }, 0], [{ rerun: new Error("HTTP 403") }, 1]];
    for (const [over, rerunCalls] of cases) {
      await withCard(over, async (c) => {
        await c.tick();
        expect([JSON.stringify(over), c.state()]).toEqual([JSON.stringify(over), BOUNCED]);
        expect(c.reruns()).toBe(rerunCalls);
      });
    }
  });

  test("a test process without a ciRerun on the external never reaches the real gh: plain bounce as before", async () => {
    await withCard({}, async (c) => {
      const plain = { inspect: async () => red(), freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
        carryReview: async () => ({ ok: false, reason: "" }), updateBranch: async () => {}, merge: async () => "" } as MergeExternal;
      await schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler"), () => plain);
      expect([c.state(), c.gh.argv]).toEqual([BOUNCED, []]);
    });
  });
});

describe("i28-CIF1f1 after the rerun only a newer attempt counts; the old one still showing waits, up to RERUN_SETTLE_MS", () => {
  const WAITING = { run: "await_ci", stage: "merge" };
  const reason = (c: ReturnType<typeof card>) => getMergeRun(c.db, c.intent)?.reason ?? "";
  const reads = (c: ReturnType<typeof card>) => c.gh.argv.filter((a) => a.includes("--log-failed") || a[1] === "pr").length;

  test("rerun accepted, next tick still attempt 1 / completed / failure → waits with a readable reason; then attempt 2 green → merges", async () => {
    await withCard({ lag: true }, async (c) => {
      await c.tick(200);
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      expect(reason(c)).toStartWith(`${RERUN_WAIT}：`);
      const before = reads(c);
      await c.tick(200 + 60_000);
      expect([c.state(), c.reruns(), reads(c)]).toEqual([WAITING, 1, before]); // the old attempt's log is not judged again
      expect(reason(c)).toStartWith(RERUN_WAIT);
      expect(c.events("merge_conflict")).toEqual([]);
      Object.assign(c.gh, { attempt: 2, status: "completed", conclusion: "success" });
      c.setSnap({ ...red(), mergeState: "CLEAN", checks: [{ name: "ci", bucket: "pass" }] });
      await c.tick(200 + 120_000);
      expect(c.state().run).toBe("unknown"); // reached the merge call (the fake refuses it)
      expect(c.reruns()).toBe(1);
    });
  });

  test("the newer attempt ends red → ci_fail back to fix, still one rerun", async () => {
    await withCard({ lag: true }, async (c) => {
      await c.tick(200);
      await c.tick(300);
      Object.assign(c.gh, { attempt: 2, status: "completed", conclusion: "failure" });
      await c.tick(400);
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
      expect(c.events("merge_ci_rerun_stale")).toEqual([]);
    });
  });

  test("no newer attempt past the limit → ci_fail back to fix, the reason says 重跑没有开始", async () => {
    await withCard({ lag: true }, async (c) => {
      await c.tick(200);
      await c.tick(200 + RERUN_SETTLE_MS - 1);
      expect(c.state()).toEqual(WAITING);
      await c.tick(200 + RERUN_SETTLE_MS);
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
      const [stale, ...more] = c.events("merge_ci_rerun_stale");
      expect(more).toEqual([]);
      expect(stale).toMatchObject({ reason: "重跑没有开始", prHead: HEAD, run: RUN });
      expect(stale.text).toContain("重跑没有开始");
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
    });
  });
});

describe("i28-CIF1f1 the stale-attempt wait holds in every phase that can claim a rerun (ready, updating, await_ci)", () => {
  for (const phase of ["ready", "updating", "await_ci"]) {
    test(`${phase}: old attempt still showing and its log unreadable → waits, no log or file read; past the limit → 重跑没有开始`, async () => {
      await withCard({ lag: true }, async (c) => {
        c.db.query("UPDATE scheduler_merges SET phase=? WHERE intentId=?").run(phase, c.intent);
        await c.tick(200);
        expect([c.state(), c.reruns()]).toEqual([{ run: phase, stage: "merge" }, 1]);
        c.gh.log = new Error("run 77 is still in progress; logs will be available when it is complete");
        const before = c.gh.argv.filter((a) => a.includes("--log-failed") || a[1] === "pr").length;
        await c.tick(300);
        expect([c.state(), c.reruns()]).toEqual([{ run: phase, stage: "merge" }, 1]);
        expect(getMergeRun(c.db, c.intent)?.reason ?? "").toStartWith(RERUN_WAIT);
        expect(c.gh.argv.filter((a) => a.includes("--log-failed") || a[1] === "pr").length).toBe(before);
        expect(c.events("merge_conflict")).toEqual([]);
        await c.tick(200 + RERUN_SETTLE_MS);
        expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
        expect(c.events("merge_ci_rerun_stale")).toEqual([expect.objectContaining({ reason: "重跑没有开始" })]);
      });
    });
  }

  test("ready: the newer attempt ends red → ci_fail back to fix, still one rerun", async () => {
    await withCard({ lag: true }, async (c) => {
      c.db.query("UPDATE scheduler_merges SET phase='ready' WHERE intentId=?").run(c.intent);
      await c.tick(200);
      await c.tick(300);
      Object.assign(c.gh, { attempt: 2, status: "completed", conclusion: "failure" });
      await c.tick(400);
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
      expect(c.events("merge_ci_rerun_stale")).toEqual([]);
    });
  });
});

describe("bun test failed-log parsing", () => {
  test("collects (fail) lines with their file group and timeout marker; the closing recap is not a new failure", () => {
    const log = ciLog([at(`##[group]${SLOW}:`), at("(fail) slow [6189.00ms]"), at("  ^ this test timed out after 5000ms."), at("##[endgroup]"),
      at("##[group]tests/b.test.ts:"), at("error: boom"), at("(fail) b > broke [0.40ms]"), at("##[endgroup]"), at("(fail) slow [6189.00ms]")], 2);
    expect(parseFailedLog(log)).toEqual([{ file: SLOW, name: "slow", timedOut: true }, { file: "tests/b.test.ts", name: "b > broke", timedOut: false }]);
  });
  test("refuses what it cannot account for", () => {
    for (const log of ["", ciLog([], 0), ciLog([at("(fail) loose [1.00ms]")]), TIMEOUT_ONLY.replace(" 1 fail", " 3 fail"),
      `${TIMEOUT_ONLY}\nci\tGuard\t2026-10-02T11:05:00Z ##[error]guard red`, TIMEOUT_ONLY.replace("##[endgroup]", "# Unhandled error between tests"),
      TIMEOUT_ONLY.replace("##[endgroup]", "##[endgroup]\n" + at("error: failed to write coverage report")),
      TIMEOUT_ONLY.replace("##[endgroup]", "##[endgroup]\n" + at("##[error]coverage threshold not met")),
      TIMEOUT_ONLY.replace("(pass) fine [1.00ms]", "(pass) fine [1.00ms]\n" + at("error: stray failure"))]) {
      expect(parseFailedLog(log)).toBeNull();
    }
  });
  test("an error printed for a (fail) makes it a non-timeout even with the timeout marker", () => {
    const log = TIMEOUT_ONLY.replace(at("(fail) 本机"), `${at("error: write EPIPE")}\n${at("(fail) 本机")}`);
    expect(parseFailedLog(log)).toEqual([{ file: SLOW, name: "本机 API last-seen > 过滤在 LIMIT 之前", timedOut: false }]);
  });
  test("rerun receipt round-trips and stays inside the ledger's 600-unit gate", () => {
    const cases = Array.from({ length: 30 }, (_, i) => `tests/t${i}.test.ts > ${"很长的用例名".repeat(30)}`);
    const receipt = rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases });
    expect(receipt.length).toBeLessThanOrEqual(600);
    expect(parseRerunReceipt(receipt)).toMatchObject({ prHead: HEAD, link: RUN, checks: ["ci"] });
    expect(parseRerunReceipt(bounceReceipt({ cause: "ci_fail", prHead: HEAD, mainHead: null, checks: [{ name: "ci", link: RUN }] }))).toBeNull();
  });
});
