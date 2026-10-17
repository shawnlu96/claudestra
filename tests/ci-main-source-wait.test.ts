/**
 * merge-arch-CIMAINSRC1 · the evidence half: each failure of a bun test log as test file + test name + error fingerprint, only noise
 * normalized, and the match rule (every PR failure has the same triple on main). Anything that cannot form a triple is no evidence.
 * The scheduler flow is tests/ci-main-source-wait-flow.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorFingerprint, failureTriples, mainSourceGh, matchSource, normalizeError, tripleDigest } from "../src/lib/ci-main-source-wait.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";

const at = (line: string, job = "ci", step = "Run tests") => `${job}\t${step}\t2026-10-17T01:02:03.1234567Z ${line}`;
const log = (groups: string[][], fails: number, tail: string[] = []) => [
  at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"),
  ...groups.flat().map((l) => at(l)), at(""), at(" 1999 pass"), at(` ${fails} fail`), at("Ran 2000 tests across 300 files. [90.00s]"),
  ...tail.map((l) => at(l)), at("##[error]Process completed with exit code 1."),
].join("\n");
const STALE = "tests/lend-claude-capacity.test.ts";
const assertion = (error: string, name = "capacity > 窗口未过期", ms = "0.40") =>
  [`##[group]${STALE}:`, error, "", "Expected: 1", "Received: 2", "", `      at <anonymous> (/home/runner/work/repo/repo/${STALE}:10:5)`,
    `(fail) ${name} [${ms}ms]`, "##[endgroup]"];
const PR1593 = readFileSync(join(import.meta.dir, "fixtures", "ci-log-timeout-pr1593-shard.txt"), "utf8");

describe("[验收线 1] failure triples", () => {
  test("an assertion: file + name + its whole error block digested (error, Expected / Received), run time and stack frames left out", () => {
    expect(failureTriples(log([assertion("error: expect(received).toBe(expected)")], 1))).toEqual([{ file: STALE, name: "capacity > 窗口未过期",
      fp: errorFingerprint(["error: expect(received).toBe(expected)", "Expected: 1", "Received: 2"]) }]);
    expect(errorFingerprint(["error: x", "", "      at <anonymous> (src/a.ts:1:2)"])).toBe(errorFingerprint(["error: x"]));
    expect(errorFingerprint(["error: x"])).toMatch(/^error: x #[a-f0-9]{32}$/);
  });

  test("multi-line Expected / Received values are part of the fingerprint: same test, Received role guest vs owner never match", () => {
    const received = (role: string) => [`##[group]${STALE}:`, "error: expect(received).toEqual(expected)", "", "  {", `-   "role": "admin",`,
      `+   "role": "${role}",`, "  }", "", "- Expected  - 1", "+ Received  + 1", "", `      at <anonymous> (/home/runner/work/repo/repo/${STALE}:10:5)`,
      "(fail) capacity > 窗口未过期 [0.40ms]", "##[endgroup]"];
    const guest = failureTriples(log([received("guest")], 1))!, owner = failureTriples(log([received("owner")], 1))!;
    expect(guest).not.toBeNull();
    expect(owner).not.toBeNull();
    expect(guest[0]!.fp).not.toBe(owner[0]!.fp);
    expect(matchSource(guest, owner).ok).toBe(false);
    expect(failureTriples(log([received("guest")], 1))).toEqual(guest);
  });

  test("a long error line is never cut before comparing: 310 equal characters, then A vs B, never match", () => {
    const head = "error: " + "x".repeat(303);
    const a = failureTriples(log([assertion(`${head}A`)], 1))!, b = failureTriples(log([assertion(`${head}B`)], 1))!;
    expect(a[0]!.fp).not.toBe(b[0]!.fp);
    expect(matchSource(a, b).ok).toBe(false);
  });

  test("the same failure on another run (other times, other durations, other temp dir) gives the same triple", () => {
    const a = failureTriples(log([assertion("error: ENOENT /tmp/t68g-deploy-AbC123/ledger.sqlite at 2026-10-17T01:02:03.000Z", "x", "0.40")], 1));
    const b = failureTriples(log([assertion("error: ENOENT /private/var/folders/q1/T/t68g-deploy-ZzZ999/ledger.sqlite at 2026-10-16T22:00:00Z", "x", "7.10")], 1));
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(tripleDigest(a!)).toBe(tripleDigest(b!));
  });

  test("a different error in the same test is a different fingerprint (meaning is never normalized away)", () => {
    const a = failureTriples(log([assertion("error: expect(received).toBe(expected)")], 1))!;
    const b = failureTriples(log([assertion("error: expect(received).toEqual(expected)")], 1))!;
    expect(a[0]!.fp).not.toBe(b[0]!.fp);
    expect(matchSource(a, b)).toEqual({ ok: false, why: `${STALE} > capacity > 窗口未过期 在 main 上没有同指纹失败` });
  });

  test("a timed-out test (PR1593's real shard, with its stray unhandled-error block) has the fingerprint `timeout`", () => {
    const triples = failureTriples(PR1593);
    expect(triples?.length).toBeGreaterThan(0);
    expect(triples!.every((t) => t.fp === "timeout")).toBe(true);
  });

  test("[验收线 3] no triple, no evidence: typecheck / guard steps, a crash outside a test, a cut log, an empty log", () => {
    const typecheck = [at("src/lib/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", "typecheck", "tsc"),
      at("##[error]Process completed with exit code 2.", "typecheck", "tsc")].join("\n");
    const guard = [log([assertion("error: expect(received).toBe(expected)")], 1),
      at("❌ guard: src/lib/x.ts 超过 800 行", "guard", "bun run guard"), at("##[error]Process completed with exit code 1.", "guard", "bun run guard")].join("\n");
    const crash = log([[`##[group]${STALE}:`, "error: Cannot find module './gone.js'", "##[endgroup]"]], 0);
    const cut = log([assertion("error: expect(received).toBe(expected)").slice(0, 3)], 1);
    for (const bad of [typecheck, guard, crash, cut, ""]) expect(failureTriples(bad)).toBeNull();
  });
});

describe("[验收线 1] the match rule", () => {
  const t = (file: string, name: string, fp = "error: x") => ({ file, name, fp });
  test("every PR triple on main (main may fail more) matches; one PR failure missing on main does not; an empty side never does", () => {
    expect(matchSource([t("a", "1")], [t("a", "1"), t("b", "2")])).toEqual({ ok: true });
    expect(matchSource([t("a", "1"), t("c", "3")], [t("a", "1")])).toEqual({ ok: false, why: "c > 3 在 main 上没有同指纹失败" });
    expect(matchSource([t("a", "1")], [t("a", "1", "error: y")]).ok).toBe(false);
    expect(matchSource([], [t("a", "1")]).ok).toBe(false);
    expect(matchSource([t("a", "1")], []).ok).toBe(false);
  });

  test("normalization keeps values and paths inside the repository", () => {
    expect(normalizeError("error: expected 3 got 4 [12.5ms]")).toBe("error: expected 3 got 4");
    expect(normalizeError("error: /home/runner/work/repo/repo/src/lib/x.ts failed at 1760662923000")).toBe("error: src/lib/x.ts failed at <epoch>");
  });
});

describe("main's push CI read through main-red-fix's gh port", () => {
  test("ci.yml push runs on main; one attempt's failed log; a log too long is an error, never evidence", async () => {
    const argv: string[][] = [];
    const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    let log = "log";
    const gh = mainSourceGh((async (a: string[]) => {
      argv.push(a);
      return a[1] === "api"
        ? ok(JSON.stringify({ workflow_runs: [{ id: 9, run_attempt: 1, head_branch: "main", head_sha: "E".repeat(40), status: "completed",
          conclusion: "failure", created_at: "2026-10-17T01:00:00Z", html_url: "https://github.com/example/repo/actions/runs/9" }] }))
        : ok(log);
    }) as never);
    expect(await gh.mainRuns("example/repo")).toEqual([{ id: 9, attempt: 1, headSha: "e".repeat(40), status: "completed", conclusion: "failure",
      url: "https://github.com/example/repo/actions/runs/9", createdAt: Date.parse("2026-10-17T01:00:00Z") }]);
    expect(await gh.failedLog("example/repo", "9", 1)).toBe("log");
    expect(argv).toEqual([
      ["gh", "api", "-H", "Accept: application/vnd.github+json", "repos/example/repo/actions/workflows/ci.yml/runs?branch=main&per_page=20&event=push"],
      ["gh", "run", "view", "9", "--repo", "example/repo", "--attempt", "1", "--log-failed"]]);
    log = "x".repeat(1024 * 1024);
    expect(gh.failedLog("example/repo", "9", 1)).rejects.toThrow("太长");
  });
});
