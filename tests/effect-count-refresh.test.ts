/**
 * EFFAUTO1 through the real merge tick and ledger (CIF1's card kit), with the git ports stubbed: a CI red only on the effect-site
 * inventory counts is refreshed and pushed under effCountRefresh=on (no bounce to fix; the moved head goes back to review on the
 * existing movedHead road), noted and still bounced under observe, untouched under off. Every refusal bounces with the receipt
 * off produces. The git side on real repositories is tests/effect-count-refresh-git.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { countOnlyRed, effCountRefreshStep, EFF_COUNT_REFRESH_KEY, useEffCountRefreshPorts, type EffCountRefreshPorts, type RefreshNote }
  from "../src/lib/effect-count-refresh.js";
import type { RefreshPush, RefreshPushInput, RefreshTrial, RefreshTrialInput } from "../src/lib/effect-count-refresh-git.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun, type MergeRun } from "../src/lib/scheduler-merge.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW = "d".repeat(40), PR = "https://github.com/example/repo/pull/7", RUN = "https://github.com/example/repo/actions/runs/77";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const at = (line: string) => `ci\tRun tests\t2026-10-14T03:02:03.1234567Z ${line}`;
const group = (file: string, name: string) => [at(`##[group]${file}:`), at("error: expect(received).toBe(expected)"),
  at(`(fail) ${name} [12.00ms]`), at("##[endgroup]")];
const ciLog = (body: string[], fails: number) => [at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"), ...body,
  at(""), at(" 1998 pass"), at(` ${fails} fail`), at("Ran 2000 tests across 300 files. [90.00s]"), at("##[error]Process completed with exit code 1.")].join("\n");
const S2D2 = group("tests/shared-ledger-v2-stage2-skip-paths.test.ts", "S2D2 effect-site inventory > every effect site is registered");
const EFFCNT = group("tests/skip-effects.test.ts", "EFFCNT1 real inventory end to end > the real inventory matches the scan");
const COUNT_ONLY = ciLog([...S2D2, ...EFFCNT], 2);
const WITH_OTHER = ciLog([...S2D2, ...group("tests/b.test.ts", "b > 断言")], 2);
const OK: RefreshTrial = { ok: true, sha: NEW, files: ["src/lib/scheduler-v2-skip-effects.ts"],
  entries: [{ file: "usage-store.ts", gate: "db", from: "sql=28 stmt=36 fs=1", to: "sql=32 stmt=44 fs=1" }] };

const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
/** gh for run 77 / PR 7: attempt `attempt` (1 unless said) red, the given failed log, PR files outside the tests. */
const fakeGh = (log: string, attempt = 1) => async (argv: string[]): Promise<BoundedResult> => {
  const cmd = argv.slice(1).join(" ");
  if (cmd === "run view 77 --repo example/repo --json attempt,status,conclusion") return ok(JSON.stringify({ attempt, status: "completed", conclusion: "failure" }));
  if (cmd === "run view 77 --repo example/repo --log-failed") return ok(log);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: [{ path: "src/lib/usage-store.ts" }] }));
  return { code: 1, stdout: "", stderr: `unexpected gh ${cmd}`, timedOut: false };
};
const red = (head = HEAD): PrSnapshot => ({ state: "OPEN", head, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
  mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] });

interface Opts { mode: RecoveryMode; log?: string; attempt?: number; trial?: RefreshTrial; remote?: string | null; push?: RefreshPush; keepNote?: boolean;
  gh?: (argv: string[]) => Promise<BoundedResult> }
interface Seen { trials: RefreshTrialInput[]; pushes: RefreshPushInput[]; notes: RefreshNote[] }

/** One tick of the real merge pass on CIF1's await_ci card, its CI red with `log`; then what the ledger holds. */
async function drive(opts: Opts, after?: (c: ReturnType<typeof mergedCard>, tick: (pr: PrSnapshot) => Promise<unknown>) => Promise<void>) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  const seen: Seen = { trials: [], pushes: [], notes: [] };
  const ports: Partial<EffCountRefreshPorts> = { mode: () => opts.mode, repoDir: () => "/repo",
    trial: async (i) => { seen.trials.push(i); return opts.trial ?? OK; },
    remoteHead: async () => opts.remote === undefined ? HEAD : opts.remote,
    push: async (i) => { seen.pushes.push(i); return opts.push ?? { ok: true }; },
    ...(opts.keepNote ? {} : { note: async (n: RefreshNote) => { seen.notes.push(n); } }) };
  using _ports = useEffCountRefreshPorts(ports);
  const tick = (pr: PrSnapshot) => {
    const external = { inspect: async () => pr, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
      carryReview: async () => ({ ok: false, reason: "不是纯 main 合并" }), updateBranch: async () => {}, merge: async () => { throw new Error("不该合并"); },
      ciRerun: ciRerunGh((opts.gh ?? fakeGh(opts.log ?? COUNT_ONLY, opts.attempt)) as never) } as MergeExternal;
    // the deploy kit's scheduler writer, with auto dispatch on for p so `scheduler-recovery-observe` takes the note
    const manager = async (...args: string[]) => runLedger(args.slice(1), { db: c.db, actor: "scheduler", projectIds: ["p"], now: () => 200,
      loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, autoDispatch: () => true, autoProjects: () => ["p"] });
    return schedulerMergeTick(c.db, config, manager, () => external);
  };
  try {
    await tick(red());
    if (after) await after(c, tick);
    const stage = (c.db.query("SELECT stage, headSHA FROM tasks WHERE id='T9'").get() as { stage: string; headSHA: string });
    const events = (where: string) => (c.db.query(`SELECT kind, text, data FROM events WHERE target='T9' AND ${where} ORDER BY seq`).all() as
      { kind: string; text: string; data: string }[]).map((e) => ({ kind: e.kind, text: e.text, ...JSON.parse(e.data) }));
    return { ...seen, run: getMergeRun(c.db, c.intent)?.phase, stage: stage.stage, head: stage.headSHA,
      bounce: events("kind='scheduler' AND json_extract(data,'$.op')='merge_conflict'").map(({ text, cause, prHead, checks }) => ({ text, cause, prHead, checks })),
      observed: events("kind='note' AND json_extract(data,'$.op')='recovery_observe'") };
  } finally { c.close(); }
}

describe("EFFAUTO1 effect-site count refresh in the merge queue", () => {
  test("the key is a recovery key; countOnlyRed needs every failure in the two inventory groups", () => {
    expect(RECOVERY_KEYS).toContain(EFF_COUNT_REFRESH_KEY);
    expect(countOnlyRed(parseFailedLog(COUNT_ONLY))).toBe(true);
    expect(countOnlyRed(parseFailedLog(ciLog(S2D2, 1)))).toBe(true);
    expect(countOnlyRed(parseFailedLog(WITH_OTHER))).toBe(false);
    expect(countOnlyRed(parseFailedLog(ciLog(group("tests/skip-effects.test.ts", "EFFCNT1 rewrite > keeps comments"), 1)))).toBe(false); // other group, same file
    expect(countOnlyRed([])).toBe(false);
    expect(countOnlyRed(null)).toBe(false);
  });

  test("[验收线 4] off: today's bounce to fix, no trial, no note, no push", async () => {
    const off = await drive({ mode: "off" });
    expect([off.run, off.stage]).toEqual(["resolved", "fix"]);
    expect(off.bounce).toEqual([{ text: expect.any(String), cause: "ci_fail", prHead: HEAD, checks: [{ name: "ci", link: RUN }] }]);
    expect([off.trials.length, off.notes.length, off.pushes.length]).toEqual([0, 0, 0]);
  });

  test("[验收线 1] on: the count-only commit is pushed, the card is not bounced; the moved head goes back to review via movedHead", async () => {
    const off = await drive({ mode: "off" });
    let mid: { run?: string; stage?: string } = {}, lag: typeof mid = {};
    const on = await drive({ mode: "on" }, async (c, tick) => {
      const now = () => ({ run: getMergeRun(c.db, c.intent)?.phase, stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
      mid = now();
      await tick(red()); // the push is not on GitHub yet
      lag = now();
      await tick(red(NEW)); // the next pass reads the pushed head: no main-merge carry, so the existing update-branch road re-reviews it
    });
    expect(mid).toEqual({ run: "updating", stage: "merge" });
    expect(lag).toEqual({ run: "updating", stage: "merge" }); // GitHub still showed the old red head: waited, not bounced
    expect(on.trials).toEqual([{ repoDir: "/repo", repository: "example/repo", branch: "feat/t9", head: HEAD }]);
    expect(on.pushes).toEqual([{ repoDir: "/repo", branch: "feat/t9", head: HEAD, sha: NEW }]);
    expect([on.run, on.stage, on.head]).toEqual(["await_review", "review", NEW]);
    expect(on.bounce).toEqual([]); // never back to fix (off bounced the very same red)
    expect(off.bounce).toHaveLength(1);
    expect(on.notes.map((n) => [n.actionKey, n.data.onlyCountCommit])).toEqual([[`pushed.${HEAD.slice(0, 12)}`, true]]);
    expect(on.notes[0]!.action).toContain("只有这一个计数提交");
  });

  test("[验收线 1] a run already re-run (attempt 2) red only on counts: the current log is read, refreshed once; others bounce as before", async () => {
    const off = await drive({ mode: "off", attempt: 2 });
    expect([off.run, off.stage, off.trials.length]).toEqual(["resolved", "fix", 0]);
    const on = await drive({ mode: "on", attempt: 2 }, async (_c, tick) => { await tick(red(NEW)); });
    expect([on.trials.length, on.pushes.length, on.bounce, on.stage]).toEqual([1, 1, [], "review"]);
    const other = await drive({ mode: "on", attempt: 2, log: WITH_OTHER });
    expect([other.bounce, other.trials.length, other.notes.length]).toEqual([await drive({ mode: "off", attempt: 2, log: WITH_OTHER }).then((r) => r.bounce), 0, 0]);
    expect(other.bounce).toEqual(off.bounce);
  });

  test("[验收线 1] a claimed rerun (CIF1) that ends red only on counts: refreshed once, not bounced; any other second red bounces as before", async () => {
    const SLOW = ciLog([at("##[group]tests/a.test.ts:"), at("(fail) slow [6000.00ms]"), at("  ^ this test timed out after 5000ms."), at("##[endgroup]")], 1);
    /** attempt 1 timed out only (CIF1 claims and re-runs it), then attempt 2 completed red with `second`. */
    const rerunGh = (second: string) => {
      let rerun = false;
      return async (argv: string[]): Promise<BoundedResult> => {
        const cmd = argv.slice(1).join(" ");
        if (cmd === "run rerun 77 --failed --repo example/repo") { rerun = true; return ok(""); }
        return fakeGh(rerun ? second : SLOW, rerun ? 2 : 1)(argv);
      };
    };
    const claimedThen = (mode: RecoveryMode, second: string) => {
      let claim = "";
      return drive({ mode, gh: rerunGh(second) }, async (c, tick) => {
        claim = (c.db.query("SELECT reason FROM scheduler_merges WHERE intentId=?").get(c.intent) as { reason: string }).reason;
        await tick(red());
        if (mode === "on" && second === COUNT_ONLY) await tick(red(NEW));
      }).then((r) => ({ ...r, claim }));
    };
    const on = await claimedThen("on", COUNT_ONLY);
    expect(on.claim.startsWith("等 CI 重跑开始：")).toBe(true);
    expect([on.trials.length, on.pushes.length, on.bounce, on.stage]).toEqual([1, 1, [], "review"]);
    const off = await claimedThen("off", COUNT_ONLY);
    expect([off.run, off.stage, off.trials.length, off.bounce.length]).toEqual(["resolved", "fix", 0, 1]);
    const other = await claimedThen("on", WITH_OTHER);
    expect([other.stage, other.trials.length, other.pushes.length, other.notes.length]).toEqual(["fix", 0, 0, 0]);
    expect(other.bounce).toEqual((await claimedThen("off", WITH_OTHER)).bounce);
  });

  test("[验收线 4] observe: still bounced with off's receipt, one would-refresh note written through the ledger", async () => {
    const off = await drive({ mode: "off" });
    const observe = await drive({ mode: "observe", keepNote: true });
    expect([observe.run, observe.stage, observe.bounce]).toEqual(["resolved", "fix", off.bounce]);
    expect(observe.trials).toHaveLength(1);
    expect(observe.pushes).toHaveLength(0);
    expect(observe.observed).toHaveLength(1);
    expect(observe.observed[0]).toMatchObject({ kind: "note", mechanism: EFF_COUNT_REFRESH_KEY });
    expect(JSON.stringify(observe.observed[0])).toContain("本可修");
    const not = await drive({ mode: "observe", trial: { ok: false, reason: "skip-effects 退出 1（有未登记的新文件，要人定组）", exitCode: 1 } });
    expect([not.bounce, not.notes.map((n) => n.action)]).toEqual([off.bounce, ["不可修，仍退回 fix：skip-effects 退出 1（有未登记的新文件，要人定组）"]]);
    expect(not.notes[0]!.data).toMatchObject({ exitCode: 1, mode: "observe" });
  });

  test("[验收线 2] another failing case, exit 1 / 2, a change outside the inventory or a non count-only class: bounced as before", async () => {
    const off = await drive({ mode: "off" });
    const other = await drive({ mode: "on", log: WITH_OTHER });
    expect([other.bounce, other.trials.length, other.notes.length]).toEqual([await drive({ mode: "off", log: WITH_OTHER }).then((r) => r.bounce), 0, 0]);
    const refusals: RefreshTrial[] = [
      { ok: false, reason: "skip-effects 退出 1（有未登记的新文件，要人定组）", exitCode: 1 },
      { ok: false, reason: "skip-effects 退出 2（清单原文对不上）", exitCode: 2 },
      { ok: false, reason: "改动不只在清单：src/lib/x.ts", exitCode: 0, files: ["src/lib/scheduler-v2-skip-effects.ts", "src/lib/x.ts"] },
      { ok: false, reason: "SKIPAUTO1 分类不是纯计数改动：未登记的效果文件：x.ts", exitCode: 0, classification: ["未登记的效果文件：x.ts"] },
    ];
    for (const trial of refusals) {
      const r = await drive({ mode: "on", trial });
      expect([r.run, r.stage, r.bounce, r.pushes.length]).toEqual(["resolved", "fix", off.bounce, 0]);
      expect(r.notes.map((n) => n.action)).toEqual([`效果点计数自动刷新没成，退回 fix：${trial.ok ? "" : trial.reason}`]);
    }
  });

  test("[验收线 3] the remote branch moved before the push: nothing claimed or pushed, bounced as before", async () => {
    const off = await drive({ mode: "off" });
    const moved = await drive({ mode: "on", remote: "f".repeat(40) });
    expect([moved.run, moved.stage, moved.bounce, moved.pushes.length]).toEqual(["resolved", "fix", off.bounce, 0]);
    expect(moved.notes[0]!.action).toContain("PR 分支已不在 CI 的 head");
    const refused = await drive({ mode: "on", push: { ok: false, moved: true, reason: "PR 分支已不在 CI 的 head（远端 ffffffffffff）" } });
    expect([refused.run, refused.stage, refused.pushes.length]).toEqual(["resolved", "fix", 1]); // moved between check and push: bounce
    expect(refused.bounce.map((b) => b.cause)).toEqual(["ci_fail"]);
  });

  test("[验收线 3] one try per card and head: the same head red on counts again is not tried or pushed again", async () => {
    const seen: RefreshTrialInput[] = [];
    using _ports = useEffCountRefreshPorts({ mode: () => "on", repoDir: () => "/repo", trial: async (i) => { seen.push(i); return OK; },
      remoteHead: async () => HEAD, push: async () => ({ ok: true }), note: async () => {} });
    const run = { intentId: "i", taskId: "t", project: "p", prRef: PR, expectedBranch: "feat/t9", reviewedHead: HEAD, requiredChecks: "ci",
      phase: "await_ci", rev: 1, mergeSha: null, reason: null } as unknown as MergeRun;
    const failures = parseFailedLog(COUNT_ONLY);
    const steps: string[] = [];
    const step = async (to: MergeRun["phase"]) => { steps.push(to); return { ...run, phase: to }; };
    const bounce = async () => ({ ...run, phase: "resolved" as const });
    expect((await effCountRefreshStep(run, red(), step, failures, bounce))?.phase).toBe("updating");
    expect(await effCountRefreshStep(run, red(), step, failures, bounce)).toBeNull();
    expect([seen.length, steps]).toEqual([1, ["updating"]]);
    // a run in a phase that cannot claim updating, or a head that is not the CI head, is never tried
    expect(await effCountRefreshStep({ ...run, reviewedHead: NEW, phase: "updating" }, red(NEW), step, failures, bounce)).toBeNull();
    expect(await effCountRefreshStep({ ...run, reviewedHead: "e".repeat(40) }, red(), step, failures, bounce)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
