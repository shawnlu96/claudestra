/**
 * i28-CIF2: red required CI whose failing test files the PR does not touch, and that main changed since the merge-base, merges
 * main in (update-branch pinned to the reviewed head) once instead of bouncing to fix; every other red (or any doubt) still
 * bounces. Fixture logs, a fake gh argv runner and a temporary git repository; no network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMergeRun, advanceMergeRun, carryReceipt } from "../src/lib/scheduler-merge.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { BEHIND_SETTLE_MS, behindReceipt, ciBehindGh, parseBehindReceipt } from "../src/lib/scheduler-merge-ci-behind.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { runBounded, type BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW = "a".repeat(40), PR = "https://github.com/example/repo/pull/7";
const RUN = "https://github.com/example/repo/actions/runs/77", RUN2 = "https://github.com/example/repo/actions/runs/78";
const BASE = "b".repeat(40), FIX = "f".repeat(40), OLD = "0".repeat(40);
const STALE = "tests/lend-claude-capacity.test.ts";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

const at = (line: string) => `ci\tRun tests\t2026-10-02T11:02:03.1234567Z ${line}`;
const ciLog = (body: string[], fails = 1) => [
  at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"),
  ...body, at(""), at(" 1999 pass"), at(` ${fails} fail`), at("Ran 2000 tests across 300 files. [90.00s]"),
  at("##[error]Process completed with exit code 1."),
].join("\n");
/** A hard-coded date that expired: an assertion, not a timeout, so CIF1 bounces and this layer decides. */
const STALE_DATE = ciLog([at(`##[group]${STALE}:`), at("error: expect(received).toBeGreaterThan(expected)"),
  at("(fail) capacity > 窗口未过期 [0.40ms]"), at("##[endgroup]")]);

interface Gh { log: string | Error; files: string[]; compare: { base: string; commits: string[] } | Error; history: string[];
  update: Error | null; argv: string[][]; onUpdate: () => void }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): BoundedResult => ({ code: 1, stdout: "", stderr, timedOut: false });
/** Answers gh argv like the real CLI would (post `--jq`) for PR 7 and its runs. */
const fakeGh = (gh: Gh) => async (argv: string[]): Promise<BoundedResult> => {
  gh.argv.push(argv);
  const cmd = argv.slice(1).join(" ");
  if (/^run view \d+ --repo example\/repo --json attempt,status,conclusion$/.test(cmd)) {
    return ok(JSON.stringify({ attempt: 1, status: "completed", conclusion: "failure" }));
  }
  if (/^run view \d+ --repo example\/repo --log-failed$/.test(cmd)) return gh.log instanceof Error ? no(gh.log.message) : ok(gh.log);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: gh.files.map((path) => ({ path })) }));
  if (/^api repos\/example\/repo\/compare\/[a-f0-9]{40}\.\.\.main --jq /.test(cmd)) {
    return gh.compare instanceof Error ? no(gh.compare.message) : ok(JSON.stringify(gh.compare));
  }
  if (/^api -X GET repos\/example\/repo\/commits -f sha=[a-f0-9]{40} -f path=\S+ -F per_page=100 --jq /.test(cmd)) return ok(JSON.stringify(gh.history));
  if (/^api -X PUT repos\/example\/repo\/pulls\/7\/update-branch -f expected_head_sha=[a-f0-9]{40}$/.test(cmd)) {
    if (gh.update) return no(gh.update.message);
    gh.onUpdate();
    return ok(JSON.stringify({ message: "Updating pull request branch." }));
  }
  return no(`unexpected gh ${cmd}`);
};

const snapOf = (head: string, bucket: "fail" | "pending", link = RUN): PrSnapshot => ({ state: "OPEN", head, branch: "feat/t9", base: "main",
  draft: false, crossRepository: false, mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket, link: `${link}/job/9` }] });
const CARRY_OK = { ok: true, reason: "净 diff 一致", mainParent: FIX, mainHead: FIX, diffHash: "9".repeat(64) };

/** The deploy kit's card, put back to `await_ci` on its reviewed head before any merge was sent. */
function card(over: Partial<Gh> = {}, carry: MergeExternal["carryReview"] = async () => CARRY_OK) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  let snap = snapOf(HEAD, "fail");
  let nextHead = NEW;
  const gh: Gh = { log: STALE_DATE, files: ["src/lib/x.ts", "tests/x.test.ts"], compare: { base: BASE, commits: [OLD, FIX] }, history: [FIX, BASE],
    update: null, argv: [], onUpdate: () => { snap = snapOf(nextHead, "pending"); }, ...over };
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: FIX }), carryReview: carry,
    updateBranch: async () => { throw new Error("不该走 gh pr update-branch"); }, merge: async () => { throw new Error("不该合并"); },
    ciRerun: ciRerunGh(fakeGh(gh) as never), ciBehind: ciBehindGh(fakeGh(gh) as never) } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined,
    stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  const events = (op: string) => (c.db.query(`SELECT text, data FROM events WHERE target='T9' AND kind='scheduler' AND json_extract(data,'$.op')=?
    ORDER BY seq`).all(op) as { text: string; data: string }[]).map((e) => ({ text: e.text, ...JSON.parse(e.data) }));
  const updates = () => gh.argv.filter((a) => a.join(" ").includes("/update-branch"));
  return { ...c, gh, tick, state, events, updates, setSnap: (s: PrSnapshot) => { snap = s; }, setNextHead: (h: string) => { nextHead = h; } };
}
const withCard = async (over: Partial<Gh>, body: (c: ReturnType<typeof card>) => Promise<void>, carry?: MergeExternal["carryReview"]) => {
  const c = card(over, carry);
  try { await body(c); } finally { c.close(); }
};
const BOUNCED = { run: "resolved", stage: "fix" };

describe("i28-CIF2 merge gate merges main in when CI is red only on tests main already changed", () => {
  test("failing file outside the PR, changed on main since the merge-base → one update-branch with expected_head_sha, wait on the new head, event", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      expect(c.state()).toEqual({ run: "updating", stage: "merge" });
      expect(c.updates()).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/7/update-branch", "-f", `expected_head_sha=${HEAD}`]]);
      expect(c.events("merge_conflict")).toEqual([]);
      const [ev, ...more] = c.events("merge_ci_behind");
      expect(more).toEqual([]);
      expect(ev).toMatchObject({ intentId: c.intent, from: "await_ci", to: "updating", oldHead: HEAD, mainHead: FIX, run: RUN, checks: ["ci"],
        files: { [STALE]: [FIX.slice(0, 12)] }, commits: [FIX.slice(0, 12)] });
      expect(ev.reason).toContain("不在本 PR 改动里");
      expect(ev.text).toContain(STALE);
      // GitHub moved the head to the main-only merge: the review is carried, the run waits on the new head's CI.
      await c.tick();
      expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
      expect(getMergeRun(c.db, c.intent)?.reviewedHead).toBe(NEW);
      expect(c.events("review_carry")).toEqual([expect.objectContaining({ from: HEAD, to: NEW })]);
      await c.tick();
      expect([c.state(), c.updates().length]).toEqual([{ run: "await_ci", stage: "merge" }, 1]);
    });
  });

  test("failing file in the PR, or main never changed it after the merge-base → back to fix at once, no update-branch", async () => {
    const cases: Partial<Gh>[] = [{ files: [STALE, "src/lib/x.ts"] }, { history: [BASE] }, { compare: { base: BASE, commits: [] } }];
    for (const over of cases) {
      await withCard(over, async (c) => {
        await c.tick();
        expect([JSON.stringify(over), c.state()]).toEqual([JSON.stringify(over), BOUNCED]);
        expect(c.updates()).toEqual([]);
        expect(c.events("merge_ci_behind")).toEqual([]);
        expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", checks: [{ name: "ci", link: RUN }] })]);
      });
    }
  });

  test("new head still red after update-branch → back to fix, never a second update-branch", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      await c.tick();
      expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
      c.setSnap(snapOf(NEW, "fail", RUN2));
      await c.tick();
      expect([c.state(), c.updates().length]).toEqual([BOUNCED, 1]);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: NEW, checks: [{ name: "ci", link: RUN2 }] })]);
      expect(c.events("merge_ci_behind")).toHaveLength(1);
    });
  });

  test("new head already red the first time it is seen → carried, then back to fix, not unknown; no second update-branch", async () => {
    await withCard({ onUpdate: () => {} }, async (c) => {
      await c.tick();
      expect(c.state()).toEqual({ run: "updating", stage: "merge" });
      c.setSnap(snapOf(NEW, "fail", RUN2)); // CI on the merged head finished red between two ticks
      await c.tick();
      expect([c.state(), c.updates().length]).toEqual([BOUNCED, 1]);
      expect(c.events("review_carry")).toEqual([expect.objectContaining({ from: HEAD, to: NEW })]);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: NEW, checks: [{ name: "ci", link: RUN2 }] })]);
      expect(c.gh.argv.some((a) => a.includes("rerun"))).toBe(false);
    });
  });

  test("new head already red on first sight while BLOCKED or BEHIND → carried, then back to fix, not unknown / updating", async () => {
    for (const mergeState of ["BLOCKED", "BEHIND"]) {
      await withCard({ onUpdate: () => {} }, async (c) => {
        await c.tick(200);
        c.setSnap({ ...snapOf(NEW, "fail", RUN2), mergeState }); // main moved again (BEHIND) or protection says BLOCKED
        await c.tick(201);
        await c.tick(200 + BEHIND_SETTLE_MS + 1);
        expect([mergeState, c.state(), c.updates().length]).toEqual([mergeState, BOUNCED, 1]);
        expect(c.events("review_carry")).toEqual([expect.objectContaining({ from: HEAD, to: NEW })]);
        expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: NEW, checks: [{ name: "ci", link: RUN2 }] })]);
      });
    }
  });

  test("new head red only on a timeout in an untouched test → back to fix, no CIF1 rerun after this run merged main in", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      await c.tick();
      expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
      c.gh.log = ciLog([at("##[group]tests/slow.test.ts:"), at("(fail) slow [6189.00ms]"), at("  ^ this test timed out after 5000ms."),
        at("##[endgroup]")]);
      c.setSnap(snapOf(NEW, "fail", RUN2));
      await c.tick();
      expect([c.state(), c.updates().length]).toEqual([BOUNCED, 1]);
      expect(c.gh.argv.filter((a) => a.includes("rerun"))).toEqual([]);
      expect(c.events("merge_ci_rerun")).toEqual([]);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: NEW, checks: [{ name: "ci", link: RUN2 }] })]);
    });
  });

  test("update-branch sent but GitHub still shows the old red head → wait without a second call; past the settle window → back to fix", async () => {
    await withCard({ onUpdate: () => {} }, async (c) => {
      const t0 = 200;
      await c.tick(t0);
      await c.tick(t0 + BEHIND_SETTLE_MS - 1);
      expect([c.state(), c.updates().length]).toEqual([{ run: "updating", stage: "merge" }, 1]);
      await c.tick(t0 + BEHIND_SETTLE_MS);
      expect([c.state(), c.updates().length]).toEqual([BOUNCED, 1]);
    });
  });

  test("fail-closed: log fetch fails, log does not parse, compare fails, update-branch conflicts or errors → back to fix", async () => {
    const cases: [Partial<Gh>, number][] = [[{ log: new Error("HTTP 404") }, 0], [{ log: "garbage\nno tests here" }, 0],
      [{ compare: new Error("HTTP 502") }, 0], [{ update: new Error("HTTP 422: merge conflict between base and head") }, 1],
      [{ update: new Error("HTTP 422: expected head sha didn't match current head ref") }, 1], [{ update: new Error("HTTP 500") }, 1]];
    for (const [over, calls] of cases) {
      await withCard(over, async (c) => {
        await c.tick();
        expect([JSON.stringify(over), c.state()]).toEqual([JSON.stringify(over), BOUNCED]);
        expect(c.updates()).toHaveLength(calls);
        expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: HEAD })]);
      });
    }
  });

  test("a test process without ciRerun / ciBehind on the external never reaches the real gh: plain bounce as before", async () => {
    await withCard({}, async (c) => {
      const plain = { inspect: async () => snapOf(HEAD, "fail"), freshness: async () => ({ behindBy: 0, mainHead: FIX }),
        carryReview: async () => ({ ok: false, reason: "" }), updateBranch: async () => {}, merge: async () => "" } as MergeExternal;
      await schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler"), () => plain);
      expect([c.state(), c.gh.argv]).toEqual([BOUNCED, []]);
    });
  });

  test("ledger: a second claim in the same run, or a claim on a head that already had one, becomes the ci_fail bounce", async () => {
    await withCard({}, async (c) => {
      const receipt = behindReceipt({ prHead: HEAD, mainHead: FIX, link: RUN, checks: ["ci"], files: { [STALE]: [FIX.slice(0, 12)] } });
      expect(parseBehindReceipt(receipt)?.files).toEqual({ [STALE]: [FIX.slice(0, 12)] });
      const sch = { actor: "scheduler", now: 500 };
      const first = advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 4, receipt });
      expect([first.phase, first.rev, first.reason]).toEqual(["updating", 5, receipt]);
      const settling = advanceMergeRun(c.db, { ...sch, now: 600 }, { intentId: c.intent, from: "updating", to: "resolved", rev: 5, receipt });
      expect([settling.phase, settling.rev]).toEqual(["updating", 5]);
      // Carried to the merged head, the run is back in await_ci; a fresh claim there is refused into the bounce.
      advanceMergeRun(c.db, sch, { intentId: c.intent, from: "updating", to: "await_ci", rev: 5, newHead: NEW,
        receipt: carryReceipt({ oldHead: HEAD, newHead: NEW, mainParent: FIX, mainHead: FIX, diffHash: "9".repeat(64) }) });
      const again = advanceMergeRun(c.db, sch, { intentId: c.intent, from: "await_ci", to: "resolved", rev: 6,
        receipt: behindReceipt({ prHead: NEW, mainHead: FIX, link: RUN2, checks: ["ci"], files: { [STALE]: ["fff"] } }) });
      expect(again.phase).toBe("resolved");
      expect(c.state()).toEqual(BOUNCED);
      expect(c.events("merge_ci_behind")).toHaveLength(1);
      expect(() => advanceMergeRun(c.db, sch, { intentId: c.intent, from: "resolved", to: "resolved", rev: again.rev, receipt })).toThrow();
    });
  });
});

describe("i28-CIF2 the merged-in head keeps its review only when the PR side did not change (real git)", () => {
  let root = "", work = "", reviewed = "", fix = "";
  const sh = async (...argv: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
      { cwd: work, timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitFile = async (file: string, body: string, msg: string) => {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), body);
    await sh("add", file);
    await sh("commit", "-q", "-m", msg);
    return sh("rev-parse", "HEAD");
  };
  /** A branch off the reviewed head built by `build`, pushed to origin; returns its head. */
  const onBranch = async (name: string, build: () => Promise<unknown>) => {
    await sh("checkout", "-q", "-b", name, reviewed);
    await build();
    const head = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", `HEAD:refs/heads/${name}`);
    await sh("checkout", "-q", "feature");
    return head;
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "cif2-carry-"));
    work = join(root, "work");
    await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
    await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
    await sh("remote", "add", "origin", "https://github.com/example/repo.git"); // MAINP2: the proof binds origin to the PR's repository
    await sh("remote", "set-url", "--push", "origin", join(root, "origin.git"));
    await commitFile(STALE, "expect(window).toBe('2026-10-02T19:00')\n", "base");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "-b", "feature");
    reviewed = await commitFile("src/lib/x.ts", "export const x = 1;\n", "reviewed change");
    await sh("push", "-q", "origin", "feature");
    await sh("checkout", "-q", "main");
    fix = await commitFile(STALE, "expect(window).toBe('2099-01-01T00:00')\n", "main fixes the stale date");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "feature");
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  /** Re-pin the kit's card (task, intent, run, review) on the real reviewed head. */
  const realCard = (c: ReturnType<typeof card>) => {
    c.db.query("UPDATE tasks SET headSHA=? WHERE id='T9'").run(reviewed);
    c.db.query("UPDATE scheduler_intents SET head=? WHERE taskId='T9'").run(reviewed);
    c.db.query("UPDATE scheduler_merges SET reviewedHead=? WHERE intentId=?").run(reviewed, c.intent);
    c.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) SELECT 150,actor,project,target,kind,text,json_set(data,'$.head',?)
      FROM events WHERE target='T9' AND kind='review'`).run(reviewed); // events are append-only: the same review, on the real head
    c.setSnap(snapOf(reviewed, "fail"));
  };
  /** The network fetch is served from the local bare repo; everything else is real local git. */
  const localFetch: typeof runBounded = (argv, opts) =>
    runBounded(argv[0] === "git" && argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? join(root, "origin.git") : a)) : argv, opts);
  const carry: MergeExternal["carryReview"] = (pr, oldHead, newHead) =>
    mergeExternal(parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: work } } }).projects.p!, localFetch)
      .carryReview(pr, oldHead, newHead);

  test("first parent = reviewed head, only main merged in → no re-review, the run waits on the new head's CI", async () => {
    const merged = await onBranch("pure", () => sh("merge", "-q", "--no-edit", fix));
    expect((await sh("rev-list", "--parents", "-n", "1", merged)).split(" ").slice(1)).toEqual([reviewed, fix]);
    await withCard({ compare: { base: reviewed, commits: [fix] }, history: [fix] }, async (c) => {
      realCard(c);
      c.setNextHead(merged);
      await c.tick();
      expect(c.updates()).toEqual([["gh", "api", "-X", "PUT", "repos/example/repo/pulls/7/update-branch", "-f", `expected_head_sha=${reviewed}`]]);
      await c.tick();
      expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
      expect(getMergeRun(c.db, c.intent)?.reviewedHead).toBe(merged);
    }, carry);
  });

  test("the PR side has a new commit too → back to review as before", async () => {
    const moved = await onBranch("pr-side", async () => {
      await sh("merge", "-q", "--no-edit", fix);
      await commitFile("src/lib/x.ts", "export const x = 2;\n", "new PR-side change");
    });
    await withCard({ compare: { base: reviewed, commits: [fix] }, history: [fix] }, async (c) => {
      realCard(c);
      c.setNextHead(moved);
      await c.tick();
      await c.tick();
      expect(c.state()).toEqual({ run: "await_review", stage: "review" });
      expect(c.updates()).toHaveLength(1);
    }, carry);
  });
});
