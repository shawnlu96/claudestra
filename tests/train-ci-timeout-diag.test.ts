/**
 * dispatch-recovery-TRAINHANG1: the timeout diagnosis (shard / last test file / run, 「未取到」 with a reason), the gh adapter's Actions
 * calls (argv only, fake runner), the observe port's dedup on a temp ledger, and the CI workflow's job timeouts + its raised[] record.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { trainGh } from "../src/lib/scheduler-merge-train-gh.js";
import type { TrainCar, TrainState } from "../src/lib/scheduler-merge-train.js";
import { trainCiTimeoutPort } from "../src/lib/train-ci-timeout.js";
import { DIAG_MAX, diagnose, lastTestFile, shardOf, type HungJob } from "../src/lib/train-ci-timeout-diag.js";
import { checkSelfRaised, checkWiring } from "../scripts/guard/self.ts";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const RUN = "https://github.com/example/repo/actions/runs/77";
const job = (over: Partial<HungJob> = {}): HungJob => ({ run: 77, runUrl: RUN, job: 774, name: "test shard 4 of 4", started: true, ...over });
const LOG = "2026-10-11T09:00:00.0000000Z ##[group]tests/a.test.ts:\n(pass) a\n##[endgroup]\n2026-10-11T09:01:00.0000000Z ##[group]tests/hang.test.ts:\n(pass) b\n";

describe("[验收线 4] diagnosis: shard, last test file, run; 「未取到」 with why", () => {
  test("shard 4 log whose last group is tests/hang.test.ts", async () => {
    expect(shardOf("test shard 4 of 4")).toBe("4");
    expect(lastTestFile(LOG)).toBe("tests/hang.test.ts");
    expect(lastTestFile("::group::tests/x.test.ts:\n::group::Run bun test\n")).toBe("tests/x.test.ts"); // a step group is not a test file
    expect(await diagnose([job()], async () => ({ text: LOG, truncated: false })))
      .toBe(`分片号：4；最后在跑的测试文件：tests/hang.test.ts；run：${RUN}`);
  });

  test("missing log, cut log, no group, not a shard job, queued only, no job list: each says 未取到 and why", async () => {
    const gone = await diagnose([job()], async () => { throw new Error("HTTP 404: Not Found"); });
    expect(gone).toBe(`分片号：4；最后在跑的测试文件：未取到（日志取不到：HTTP 404: Not Found）；run：${RUN}`);
    expect(await diagnose([job()], async () => ({ text: LOG, truncated: true }))).toContain("最后在跑的测试文件：未取到（日志超过读取上限被截断）");
    expect(await diagnose([job()], async () => ({ text: "garbage\n\u0000\u0001", truncated: false }))).toContain("未取到（日志里没有测试文件分组）");
    expect(await diagnose([job({ name: "web typecheck + lint" })], async () => ({ text: LOG, truncated: false })))
      .toContain("分片号：未取到（job「web typecheck + lint」不是测试分片）");
    expect(await diagnose([job({ started: false })], async () => { throw new Error("must not read a queued job"); }))
      .toContain("最后在跑的测试文件：未取到（job 还在排队，没开跑）");
    expect(await diagnose([], async () => ({ text: "", truncated: false }), ["run 77 的 job 列表未取到：HTTP 502"]))
      .toBe("分片号：未取到；最后在跑的测试文件：未取到（job 列表没取到） | run 77 的 job 列表未取到：HTTP 502");
  });

  test("started jobs win over queued ones; the text fits the bounce receipt", async () => {
    const many = [job({ started: false, name: "typecheck + test + guard" }), ...[1, 2, 3, 4].map((n) => job({ job: n, name: `test shard ${n} of 4` }))];
    const out = await diagnose(many, async () => ({ text: LOG, truncated: false }));
    expect(out).not.toContain("typecheck");
    expect([...out].length).toBeLessThanOrEqual(DIAG_MAX);
  });
});

const ok = (stdout = ""): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const err = (stderr: string, code = 1): BoundedResult => ({ code, stdout: "", stderr, timedOut: false });
function runner(answer: (argv: string[]) => BoundedResult) {
  const seen: string[][] = [];
  return { seen, gh: trainGh((async (argv: string[]) => { seen.push(argv); return answer(argv); }) as never) };
}

describe("[验收线 3] gh adapter: runs only by train branch, cancel idempotent, errors are errors", () => {
  test("runs are listed by the exact train/ branch; any other branch is refused before gh runs", async () => {
    const r = runner(() => ok(JSON.stringify([{ id: 5, url: RUN, status: "in_progress" }])));
    expect(await r.gh.branchRuns!("example/repo", "train/1-abc")).toEqual([{ id: 5, url: RUN, status: "in_progress" }]);
    expect(r.seen[0]!.slice(0, 3)).toEqual(["gh", "api", "repos/example/repo/actions/runs?branch=train/1-abc&per_page=50"]);
    expect(r.seen[0]![4]).toContain('select(.head_branch == "train/1-abc")');
    for (const b of ["main", "task/T1", "train/../main"]) await expect(r.gh.branchRuns!("example/repo", b)).rejects.toThrow(/非列车分支/);
    expect(r.seen).toHaveLength(1);
    await expect(runner(() => ok("{}")).gh.branchRuns!("example/repo", "train/x")).rejects.toThrow(/输出无效/);
    await expect(runner(() => ok("")).gh.branchRuns!("example/repo", "train/x")).rejects.toThrow(/输出无效/);
  });

  test("cancel: accepted = requested, already completed (409) = finished, anything else throws", async () => {
    const r = runner(() => ok());
    expect(await r.gh.cancelRun!("example/repo", 9)).toBe("requested");
    expect(r.seen[0]).toEqual(["gh", "api", "-X", "POST", "repos/example/repo/actions/runs/9/cancel"]);
    expect(await runner(() => err("Cannot cancel a workflow run that is completed. (HTTP 409)")).gh.cancelRun!("example/repo", 9)).toBe("finished");
    await expect(runner(() => err("HTTP 500")).gh.cancelRun!("example/repo", 9)).rejects.toThrow(/取消 run 失败/);
    await expect(runner(() => ({ ...err(""), timedOut: true })).gh.cancelRun!("example/repo", 9)).rejects.toThrow(/取消 run 失败/);
    await expect(r.gh.cancelRun!("example/repo", -1)).rejects.toThrow(/有效 id/);
  });

  test("jobs and job logs; a log at the output cap is marked truncated", async () => {
    const jobs = runner(() => ok(JSON.stringify([{ id: 1, name: "test shard 4 of 4", status: "in_progress" }])));
    expect(await jobs.gh.runJobs!("example/repo", 9)).toEqual([{ id: 1, name: "test shard 4 of 4", status: "in_progress" }]);
    expect(jobs.seen[0]!.slice(0, 3)).toEqual(["gh", "api", "repos/example/repo/actions/runs/9/jobs?per_page=100"]);
    expect(await runner(() => ok(LOG)).gh.jobLog!("example/repo", 3)).toEqual({ text: LOG, truncated: false });
    expect((await runner(() => ok("x".repeat(1024 * 1024))).gh.jobLog!("example/repo", 3)).truncated).toBe(true);
    await expect(runner(() => err("HTTP 410: Gone")).gh.jobLog!("example/repo", 3)).rejects.toThrow(/job 日志取不到/);
  });
});

describe("[验收线 5] the production port: policy per call, observe deduped per train car", () => {
  test("missing key = observe, bad file = off; the same would-be cancel is one ledger note", () => {
    const dir = mkdtempSync(join(tmpdir(), "train-ci-port-")), path = join(dir, "recovery-policy.json");
    const ledger = tempLedgerPath("train-ci-port-"), db = openLedger(ledger);
    try {
      const port = trainCiTimeoutPort(db, () => 5, (p, k) => recoveryPolicy(p, k, path));
      expect(port.mode("p")).toBe("observe");
      writeFileSync(path, JSON.stringify({ projects: { p: { keys: { trainCiTimeout: "on" } } } }));
      expect(port.mode("p")).toBe("on");
      writeFileSync(path, "{bad");
      expect(port.mode("p")).toBe("off");
      const s = { project: "p", id: "3j-abcde" } as TrainState, car = { id: "3j-abcde", members: ["T1", "T2"] } as TrainCar;
      port.observe(s, car, "取消车厢 3j-abcde 的 CI run，确认停下后按组合红二分");
      port.observe(s, car, "取消车厢 3j-abcde 的 CI run，确认停下后按组合红二分");
      const notes = listEvents(db, { project: "p" }).filter((e) => e.data.mechanism === "trainCiTimeout");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.text).toContain("按组合红二分");
    } finally { closeLedger(ledger); }
  });
});

const ROOT = join(import.meta.dir, "..");
describe("[验收线 7] workflow job timeouts and the guard record", () => {
  test("each job has its approved timeout; required gate, always(), coverage check, fail-fast and Guard strict wiring are intact", () => {
    const text = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const jobs = (Bun.YAML.parse(text) as { jobs: Record<string, Record<string, unknown>> }).jobs;
    expect(Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v["timeout-minutes"]]))).toEqual({ tests: 35, check: 10, web: 15, desktop: 30 });
    for (const j of Object.values(jobs)) expect(j["timeout-minutes"] as number).toBeLessThan(60); // under the train car's CI timeout
    expect(jobs.check).toMatchObject({ name: "typecheck + test + guard", needs: "tests", if: "always()" });
    expect((jobs.tests!.strategy as { "fail-fast": boolean })["fail-fast"]).toBe(false);
    const steps = (jobs.check!.steps as { name?: string }[]).map((s) => s.name);
    expect(steps).toEqual(expect.arrayContaining(["All shards succeeded", "Shards cover every test file exactly once"]));
    expect(checkWiring(readFileSync(join(ROOT, "package.json"), "utf8"), text)).toEqual([]);
  });

  test("raised[] carries a fresh guard:.github/workflows/ci.yml record, 0 → 0, with a reason", () => {
    const raised = (JSON.parse(readFileSync(join(ROOT, "scripts/guard/baseline.json"), "utf8")) as { raised: { key: string; from: number; to: number; why: string }[] }).raised;
    const mine = raised.filter((r) => r.key === "guard:.github/workflows/ci.yml" && r.why.includes("TRAINHANG1"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ from: 0, to: 0 });
    expect([...mine[0]!.why.trim()].length).toBeGreaterThanOrEqual(10);
    const base = raised.filter((r) => r !== mine[0]); // the record is new relative to a base without it
    expect(checkSelfRaised([".github/workflows/ci.yml"], base, raised)).toEqual([]);
    expect(checkSelfRaised([".github/workflows/ci.yml"], raised, raised)).toEqual([".github/workflows/ci.yml"]); // reusing an old record fails
  });
});
