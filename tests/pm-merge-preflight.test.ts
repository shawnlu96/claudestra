/**
 * MAINP2 验收线 5：PM preflight 端口。fake gh 只认结构化 argv、记下每次调用（合并 API 次数、sha 钉住的 head）；必需 CI 取临时台账里
 * 卡所在项目的配置；update-branch 202 只是受理。失败的 deploy 步骤 exit 原样返回且后续不跑。真实 GitHub / 部署一律不碰。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { headChecks, main as cli, pinnedMerge, preflight, requiredChecksFor, runStrict, updateBranch, waitForHeadRuns, USAGE, type CliDeps, type Prove,
  type Run } from "../scripts/pm-merge-preflight.js";

const PR = "https://github.com/o/r/pull/7", HEAD = "a".repeat(40), NEW = "b".repeat(40), MAIN = "c".repeat(40), REVIEWED = "d".repeat(40);
const CHECKS = ["typecheck", "test-1", "test-2", "test-3", "guard", "build", "web"];
type CheckRun = { id: number; name: string; head_sha: string; status: string; conclusion: string | null };
const green = (head = HEAD, names = CHECKS): CheckRun[] => names.map((name, i) => ({ id: i + 1, name, head_sha: head, status: "completed", conclusion: "success" }));

const dir = mkdtempSync(join(tmpdir(), "mainp2-preflight-")), ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "a" });
db.query("UPDATE tasks SET pr=? WHERE id='T1'").run(PR);
afterAll(() => { closeLedger(ledgerPath); rmSync(dir, { recursive: true, force: true }); });
const main = (argv: string[], run: Run, prove?: Prove, more: CliDeps = {}) =>
  cli(argv[0] === "verify" ? argv : ["--task", "T1", ...argv], { run, prove, ledger: () => db, checksOf: (p) => (p === "p" ? CHECKS : undefined),
    sleep: async () => {}, ...more });

function fakeGh(o: { head?: string; main?: string; runs?: (head: string) => CheckRun[]; merged?: boolean; total?: number; steps?: Record<string, number>;
  afterUpdate?: string; lag?: number } = {}) {
  const calls: string[][] = [];
  let head = o.head ?? HEAD, lag = -1;
  const out = (stdout: unknown, code = 0) => ({ code, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: code ? "boom" : "", timedOut: false });
  const run: Run = async (argv) => {
    calls.push(argv);
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") {
      if (lag === 0) head = o.afterUpdate ?? NEW; // GitHub finishes the accepted update after `lag` views
      if (lag >= 0) lag--;
      return out({ state: "OPEN", headRefOid: head, baseRefName: "main", isDraft: false, isCrossRepository: false });
    }
    if (argv[0] === "gh" && argv[1] === "api") {
      const path = argv.find((a) => a.startsWith("repos/"))!;
      if (path === "repos/o/r/git/ref/heads/main") return out({ object: { sha: o.main ?? MAIN } });
      const cr = /^repos\/o\/r\/commits\/([a-f0-9]{40})\/check-runs/.exec(path);
      if (cr) { const runs = (o.runs ?? ((h) => green(h)))(cr[1]!); return out({ total_count: o.total ?? runs.length, check_runs: runs }); }
      if (path === "repos/o/r/pulls/7/update-branch") { lag = o.lag ?? 0; return out({ message: "Updating pull request branch." }); }
      if (path === "repos/o/r/pulls/7/merge") return o.merged === false ? out("", 1) : out({ merged: true, sha: "e".repeat(40) });
    }
    if (argv[0] === "git") return out("");
    const step = o.steps?.[argv.join(" ")];
    if (step !== undefined) return out("", step);
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  };
  return { run, calls, merges: () => calls.filter((c) => c.includes("repos/o/r/pulls/7/merge")) };
}
const base = { pr: PR, expectedHead: HEAD, actualMain: MAIN, checks: CHECKS };

describe("preflight gates before any API write", () => {
  test("all seven required checks green on exactly the final head → ok; nothing written", async () => {
    const g = fakeGh();
    expect(await preflight(base, g.run)).toMatchObject({ ok: true });
    expect(g.calls.every((c) => !c.includes("-X"))).toBe(true);
  });
  test("final head drift, actual main drift → refuse (exit 2)", async () => {
    expect(await preflight(base, fakeGh({ head: NEW }).run)).toMatchObject({ ok: false, exit: 2, reason: expect.stringContaining("head") });
    expect(await preflight(base, fakeGh({ main: NEW }).run)).toMatchObject({ ok: false, exit: 2, reason: expect.stringContaining("main") });
  });
  test("missing / cancelled / skipped / unknown / failed are never green and never folded into a retryable timeout", async () => {
    const one = (patch: Partial<CheckRun>) => fakeGh({ runs: (h) => green(h).map((r, i) => (i === 2 ? { ...r, ...patch } : r)) });
    const cases: [Partial<CheckRun>, number, RegExp][] = [
      [{ conclusion: "failure" }, 2, /fail/], [{ conclusion: "cancelled" }, 2, /cancelled/], [{ conclusion: "skipped" }, 2, /skipped/],
      [{ conclusion: "neutral" }, 2, /unknown/], [{ name: "other" }, 2, /缺 CI run/], [{ head_sha: NEW }, 2, /缺 CI run/],
      [{ status: "in_progress", conclusion: null }, 3, /未完成/],
    ];
    for (const [patch, exit, why] of cases) expect(await preflight(base, one(patch).run)).toMatchObject({ ok: false, exit, reason: expect.stringMatching(why) });
    // a newer failing re-run beats an older success of the same name
    const rerun = fakeGh({ runs: (h) => [...green(h), { id: 99, name: "build", head_sha: h, status: "completed", conclusion: "failure" }] });
    expect(await preflight(base, rerun.run)).toMatchObject({ ok: false, reason: expect.stringContaining("build") });
    await expect(headChecks(fakeGh({ total: 500 }).run, "o/r", HEAD, CHECKS)).rejects.toThrow(/读不全/);
  });
  test("moved head needs the independent canonical proof (fetch first); a failed or thrown proof refuses", async () => {
    const seen: unknown[] = [];
    const ok: Prove = async (i) => { seen.push(i); return { ok: true, reason: "净 diff 一致" }; };
    const g = fakeGh();
    expect(await preflight({ ...base, reviewedHead: REVIEWED, repoDir: "/r" }, g.run, ok)).toMatchObject({ ok: true });
    expect(seen).toEqual([{ repoDir: "/r", repository: "o/r", base: "main", mainHead: MAIN, oldHead: REVIEWED, newHead: HEAD }]);
    expect(g.calls.find((c) => c[0] === "git")).toEqual(["git", "fetch", "--no-tags", "--quiet", "origin", HEAD, "+refs/heads/main:refs/remotes/origin/main"]);
    expect(await preflight({ ...base, reviewedHead: REVIEWED, repoDir: "/r" }, fakeGh().run, async () => ({ ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了" })))
      .toMatchObject({ ok: false, exit: 2, reason: expect.stringContaining("净 diff") });
    expect(await preflight({ ...base, reviewedHead: REVIEWED, repoDir: "/r" }, fakeGh().run, async () => { throw new Error("git 超时"); }))
      .toMatchObject({ ok: false, exit: 2 });
    expect(await preflight({ ...base, reviewedHead: REVIEWED }, fakeGh().run, ok)).toMatchObject({ ok: false, exit: 2 });
  });
});

describe("merge: head-pinned, once, after a last re-check", () => {
  test("--merge sends exactly one PUT pinned with sha=<expected head>, then the steps in order", async () => {
    const g = fakeGh({ steps: { "git merge --ff-only origin/main": 0, "deploy now": 0 } });
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--merge",
      "--step", JSON.stringify(["git", "merge", "--ff-only", "origin/main"]), "--step", JSON.stringify(["deploy", "now"])], g.run);
    expect(r.exit).toBe(0);
    expect(g.merges()).toEqual([["gh", "api", "-X", "PUT", "repos/o/r/pulls/7/merge", "-f", `sha=${HEAD}`, "-f", "merge_method=merge"]]);
    expect(g.calls.filter((c) => c[1] === "pr" && c[2] === "view")).toHaveLength(2); // the preflight ran twice before the PUT
  });
  test("not green → no merge call at all; merge not confirmed → exit 4 and no steps", async () => {
    const red = fakeGh({ runs: (h) => green(h).map((x, i) => (i ? x : { ...x, conclusion: "failure" })) });
    expect((await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--merge"], red.run)).exit).toBe(2);
    expect(red.merges()).toEqual([]);
    const lost = fakeGh({ merged: false, steps: { "deploy now": 0 } });
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--merge",
      "--step", JSON.stringify(["deploy", "now"])], lost.run);
    expect(r.exit).toBe(4);
    expect(lost.calls.some((c) => c[0] === "deploy")).toBe(false);
    expect(await pinnedMerge(lost.run, PR, HEAD)).toMatchObject({ ok: false, exit: 4 });
  });
  test("a failing deploy / ff step stops the chain with its own exit; nothing after it runs", async () => {
    const g = fakeGh({ steps: { "git merge --ff-only origin/main": 0, "deploy now": 7, "stage live": 0 } });
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--merge",
      "--step", JSON.stringify(["git", "merge", "--ff-only", "origin/main"]), "--step", JSON.stringify(["deploy", "now"]), "--step", JSON.stringify(["stage", "live"])], g.run);
    expect(r.exit).toBe(5);
    expect(r.lines.at(-1)).toContain("exit 7");
    expect(g.calls.some((c) => c[0] === "stage")).toBe(false);
    expect(await runStrict(g.run, [["deploy", "now"], ["stage", "live"]])).toEqual({ ok: false, step: 0, argv: ["deploy", "now"], code: 7 });
    expect((await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--step", "deploy | tail"], g.run)).exit).toBe(2);
  });
});

describe("update-branch: wait for the new head's runs, then judge that head", () => {
  test("pinned update, waits for every required run to appear on the new head, never reads the old head's green", async () => {
    let polls = 0;
    const g = fakeGh({ runs: (h) => (h === HEAD ? green(HEAD) : ++polls < 3 ? green(h, CHECKS.slice(0, 3)) : green(h)) });
    expect(await waitForHeadRuns(g.run, "o/r", NEW, CHECKS, { timeoutMs: 60_000, intervalMs: 1, sleep: async () => {} })).toBe("present");
    expect(polls).toBe(3);
    const never = fakeGh({ runs: (h) => (h === HEAD ? green(HEAD) : []) });
    let t = 0;
    expect(await waitForHeadRuns(never.run, "o/r", NEW, CHECKS, { timeoutMs: 10, intervalMs: 5, sleep: async () => {}, now: () => (t += 6) })).toBe("timeout");
    const flow = fakeGh();
    const proofs: unknown[] = [];
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--update-branch", "--repo-dir", "/r"],
      flow.run, async (i: unknown) => { proofs.push(i); return { ok: true, reason: "ok" }; });
    expect(r).toMatchObject({ exit: 0 });
    expect(flow.calls.find((c) => c.includes("repos/o/r/pulls/7/update-branch"))).toContain(`expected_head_sha=${HEAD}`);
    expect(flow.calls.filter((c) => c.some((a) => a.includes("/check-runs"))).every((c) => c.some((a) => a.includes(NEW)))).toBe(true);
    expect(proofs).toEqual([expect.objectContaining({ oldHead: HEAD, newHead: NEW })]);
  });
});

describe("review r1 · async update: 202 is only accepted, the new head is the one the PR actually moved to", () => {
  test("PR head never leaves the expected head → exit 3, no proof, no merge, no CI judged on the old head after the update", async () => {
    const g = fakeGh({ lag: Infinity });
    const proofs: unknown[] = [];
    let t = 0;
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--update-branch", "--repo-dir", "/r", "--merge"], g.run,
      async (i) => { proofs.push(i); return { ok: true, reason: "ok" }; }, { now: () => (t += 60_000) });
    expect(r.exit).toBe(3);
    expect(r.lines.join()).toContain("新 head 不明");
    expect(g.merges()).toEqual([]);
    expect(proofs).toEqual([]);
    expect(g.calls.some((c) => c.some((a) => a.includes("/check-runs")))).toBe(false);
  });
  test("head moves after a few views: proof from the old head, CI only on the new head, one pinned merge on the new head", async () => {
    const g = fakeGh({ lag: 3 });
    const proofs: unknown[] = [];
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--update-branch", "--repo-dir", "/r", "--merge"], g.run,
      async (i) => { proofs.push(i); return { ok: true, reason: "ok" }; });
    expect(r).toMatchObject({ exit: 0 });
    expect(proofs).toEqual([expect.objectContaining({ oldHead: HEAD, newHead: NEW }), expect.objectContaining({ oldHead: HEAD, newHead: NEW })]);
    expect(g.calls.filter((c) => c.some((a) => a.includes("/check-runs"))).every((c) => c.some((a) => a.includes(NEW)))).toBe(true);
    expect(g.merges()).toEqual([["gh", "api", "-X", "PUT", "repos/o/r/pulls/7/merge", "-f", `sha=${NEW}`, "-f", "merge_method=merge"]]);
    expect(await updateBranch(fakeGh({ lag: 1 }).run, PR, HEAD, { timeoutMs: 1000, intervalMs: 1, sleep: async () => {} })).toBe(NEW);
  });
  test("after an update the proof is mandatory: no --repo-dir refuses before any merge", async () => {
    const g = fakeGh();
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--update-branch", "--merge"], g.run, async () => ({ ok: true, reason: "ok" }));
    expect(r.exit).toBe(2);
    expect(g.merges()).toEqual([]);
  });
});

describe("review r1 · required CI comes from the card's project policy, never the command line", () => {
  test("--checks is refused; a project with seven required checks and only one green run is not green and never merges", async () => {
    const g = fakeGh({ runs: (h) => green(h, ["typecheck"]) });
    expect((await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--checks", "typecheck", "--merge"], g.run)).exit).toBe(2);
    const r = await main(["--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--merge"], g.run);
    expect(r.exit).toBe(2);
    expect(r.lines.join()).toContain("缺 CI run");
    expect(g.merges()).toEqual([]);
  });
  test("missing task / other PR / missing, empty or duplicated project list / unreadable ledger refuse", async () => {
    const g = fakeGh();
    const go = (more: CliDeps, task = "T1") => cli(["--task", task, "--pr", PR, "--expected-head", HEAD, "--actual-main", MAIN, "--merge"],
      { run: g.run, ledger: () => db, checksOf: () => CHECKS, ...more });
    expect((await go({}, "T9")).lines.join()).toContain("没有 T9");
    expect((await go({ checksOf: () => undefined })).exit).toBe(2);
    expect((await go({ checksOf: () => [] })).exit).toBe(2);
    expect((await go({ checksOf: () => [...CHECKS, "build"] })).lines.join()).toContain("重复");
    expect((await go({ ledger: () => null })).lines.join()).toContain("台账读不了");
    expect(() => requiredChecksFor(db, "T1", "https://github.com/o/r/pull/8", () => CHECKS)).toThrow(/不是/);
    expect(await preflight({ ...base, checks: ["a", "a"] }, g.run)).toMatchObject({ ok: false, exit: 2 });
    expect(g.merges()).toEqual([]);
    expect((await cli(["--help"])).lines[0]).toBe(USAGE);
  });
});

describe("review r1 · verify subcommand: GitHub facts live, ledger read-only", () => {
  test("passes the merged PR / actual main / compare facts to verifyMergedCarry and exits by its verdict", async () => {
    db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(HEAD);
    const MERGE = "e".repeat(40);
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push(argv);
      const out = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", timedOut: false });
      if (argv[1] === "pr") return out({ state: "MERGED", baseRefName: "main", headRefOid: HEAD, mergeCommit: { oid: MERGE } });
      if (argv.includes("repos/o/r/git/ref/heads/main")) return out({ object: { sha: MAIN } });
      if (argv.includes(`repos/o/r/compare/${MERGE}...${MAIN}`)) return out({ status: "ahead" });
      if (argv[0] === "git") return { code: 0, stdout: "", stderr: "", timedOut: false };
      throw new Error(JSON.stringify(argv));
    };
    const seen: unknown[] = [];
    const verify: CliDeps["verify"] = async (_db, taskId, facts, ports) => {
      seen.push({ taskId, facts, deploy: ports.deployConfigured });
      return { ok: false, carries: 0, mergeSha: MERGE, problems: ["x"] };
    };
    const r = await main(["verify", "--task", "T1", "--repo-dir", "/r"], run, undefined, { verify, deployConfigured: () => true });
    expect(r.exit).toBe(2);
    expect(seen).toEqual([{ taskId: "T1", deploy: true, facts: { pr: { state: "MERGED", baseRefName: "main", headRefOid: HEAD, mergeSha: MERGE }, actualMain: MAIN, mainContainsMerge: true } }]);
    expect(calls.some((c) => c.includes("-X"))).toBe(false);
    expect((await main(["verify", "--task", "T1"], run)).exit).toBe(2);
  });
});
