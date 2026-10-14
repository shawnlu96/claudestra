/**
 * dispatch-recovery-CIWAIT1: one fixture for the tests of a red required check on a run that has not ended yet, shared by
 * tests/scheduler-merge-ci-rerun-wait.test.ts (CIF1 / CIF8) and tests/scheduler-merge-ci-behind-wait.test.ts (CIF2).
 * A fake gh argv runner answers both layers' calls for run 77 / PR 7; no network.
 */
import { useEffCountRefreshPorts } from "../src/lib/effect-count-refresh.js";
import { ciBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const PR = "https://github.com/example/repo/pull/7";
export const HEAD = "c".repeat(40), RUN = "https://github.com/example/repo/actions/runs/77";
const NEW = "a".repeat(40), BASE = "b".repeat(40), FIX = "f".repeat(40);
export const SLOW = "tests/local-api-last-seen.test.ts", BROKEN = "tests/b.test.ts";
/** gh's own refusal of `run view --log-failed` while any job of the run is still going. */
const STILL_RUNNING = "run 77 is still in progress; logs will be available when it is complete";
export const WAITING = { run: "await_ci", stage: "merge" }, BOUNCED = { run: "resolved", stage: "fix" };
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

const at = (line: string) => `ci\tRun tests\t2026-10-14T00:28:37.1234567Z ${line}`;
const ciLog = (body: string[]) => [
  at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"),
  ...body, at(""), at(" 1999 pass"), at(" 1 fail"), at("Ran 2000 tests across 300 files. [90.00s]"),
  at("##[error]Process completed with exit code 1."),
].join("\n");
/** One timeout in a test file the PR does not touch: CIF1 re-runs it. */
export const TIMEOUT_ONLY = ciLog([at(`##[group]${SLOW}:`), at("(fail) 本机 API last-seen > 过滤在 LIMIT 之前 [6189.00ms]"),
  at("  ^ this test timed out after 5000ms."), at("##[endgroup]")]);
/** One assertion failure in `file`: CIF1 bounces it, CIF8 and CIF2 decide. */
export const assertIn = (file: string) => ciLog([at(`##[group]${file}:`), at("error: expect(received).toBe(expected)"),
  at("(fail) b > 断言 [0.40ms]"), at("##[endgroup]")]);

export interface Gh { attempt: number; status: string; conclusion: string; headSha: string; log: string | Error; runView: Error | null; files: string[]; argv: string[][] }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): BoundedResult => ({ code: 1, stdout: "", stderr, timedOut: false });
/** Answers gh argv like the real CLI would: CIF1's calls, and CIF2's with main having changed every file after the merge-base. */
const fakeGh = (gh: Gh, onUpdate: () => void) => async (argv: string[]): Promise<BoundedResult> => {
  gh.argv.push(argv);
  const cmd = argv.slice(1).join(" ");
  if (cmd === "run view 77 --repo example/repo --json attempt,status,conclusion,headSha") {
    return gh.runView ? no(gh.runView.message) : ok(JSON.stringify({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion, headSha: gh.headSha }));
  }
  if (cmd === "run view 77 --repo example/repo --log-failed") return gh.log instanceof Error ? no(gh.log.message) : ok(gh.log);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: gh.files.map((path) => ({ path })) }));
  if (cmd === "run rerun 77 --failed --repo example/repo") {
    Object.assign(gh, { attempt: gh.attempt + 1, status: "queued", conclusion: "" });
    return ok("");
  }
  if (/^api repos\/example\/repo\/compare\/[a-f0-9]{40}\.\.\.main --jq /.test(cmd)) return ok(JSON.stringify({ base: BASE, commits: [FIX] }));
  if (/^api -X GET repos\/example\/repo\/commits -f sha=[a-f0-9]{40} -f path=\S+ -F per_page=100 --jq /.test(cmd)) return ok(JSON.stringify([FIX, BASE]));
  if (/^api -X PUT repos\/example\/repo\/pulls\/7\/update-branch -f expected_head_sha=[a-f0-9]{40}$/.test(cmd)) {
    onUpdate();
    return ok(JSON.stringify({ message: "Updating pull request branch." }));
  }
  return no(`unexpected gh ${cmd}`);
};

const snapOf = (head: string, bucket: "fail" | "pending"): PrSnapshot => ({ state: "OPEN", head, branch: "feat/t9", base: "main", draft: false,
  crossRepository: false, mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket, link: `${RUN}/job/9` }] });

/**
 * The deploy kit's card in `await_ci` on its reviewed head: the required check is red, run 77 is attempt 1 and still
 * in_progress, and gh refuses its failed log. `behind` puts CIF2's gh on the external too, so a CIF1 bounce reaches planBehind.
 */
function waitCard(over: Partial<Gh> = {}, opts: { behind?: boolean } = {}) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  const gh: Gh = { attempt: 1, status: "in_progress", conclusion: "", headSha: HEAD, log: new Error(STILL_RUNNING), runView: null,
    files: ["src/lib/x.ts", "tests/x.test.ts"], argv: [], ...over };
  let snap = snapOf(HEAD, "fail");
  const run = fakeGh(gh, () => { snap = snapOf(NEW, "pending"); }) as never;
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: FIX }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => { throw new Error("不该走 gh pr update-branch"); },
    merge: async () => { throw new Error("不该合并"); }, ciRerun: ciRerunGh(run), ...(opts.behind ? { ciBehind: ciBehindGh(run) } : {}) } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined,
    stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  const events = (op: string) => (c.db.query(`SELECT text, data FROM events WHERE target='T9' AND kind='scheduler' AND json_extract(data,'$.op')=?
    ORDER BY seq`).all(op) as { text: string; data: string }[]).map((e) => ({ text: e.text, ...JSON.parse(e.data) }));
  /** What the ledger holds for the card: a silent wait leaves both numbers as they were. */
  const written = () => ({ rev: getMergeRun(c.db, c.intent)?.rev, events: (c.db.query("SELECT count(*) AS n FROM events WHERE target='T9'").get() as { n: number }).n });
  const sent = (...words: string[]) => gh.argv.filter((a) => words.every((w) => a.includes(w))).length;
  /** gh calls a waiting tick must not make: the failed log, the PR's files, a rerun, update-branch. */
  const acted = () => ({ log: sent("--log-failed"), files: sent("pr", "files"), rerun: sent("run", "rerun"),
    update: gh.argv.filter((a) => a.join(" ").includes("/update-branch")).length });
  /** The run ended red with this failed log. */
  const finish = (log: string) => Object.assign(gh, { status: "completed", conclusion: "failure", log });
  return { ...c, gh, tick, state, events, written, acted, finish };
}
export type WaitCard = ReturnType<typeof waitCard>;
export const NOTHING = { log: 0, files: 0, rerun: 0, update: 0 };
export const withWaitCard = async (over: Partial<Gh>, body: (c: WaitCard) => Promise<void>, opts?: { behind?: boolean }) => {
  // effCountRefresh (EFFAUTO1, default observe) reads the failed log once more on a bounce; pinned off, `log` counts CIF1 / CIF2 only.
  using _offCount = useEffCountRefreshPorts({ mode: () => "off" });
  const c = waitCard(over, opts);
  try { await body(c); } finally { c.close(); }
};
