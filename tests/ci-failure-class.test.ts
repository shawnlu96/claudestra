/**
 * merge-arch-CLASS1: what a red CI log is, read without GitHub or ledger. Only untouched timeouts, untouched non-timeout failures
 * (known flaky candidates) and definite environment faults have a class that may earn a re-run; every doubt is code / unknown.
 */
import { describe, expect, test } from "bun:test";
import { classifyFailedLog, firstAsserted, firstTouched } from "../src/lib/ci-failure-class.js";

const SHARD = "test shard 2 of 4", GATE = "typecheck + test + guard";
const step = (job: string, name: string, lines: string[]) => lines.map((l) => `${job}\t${name}\t2026-10-12T09:00:00.1234567Z ${l}`);
const log = (...steps: string[][]) => steps.flat().join("\n");
const gate = step(GATE, "All shards succeeded", ["##[error]分片没有全部成功：failure", "##[error]Process completed with exit code 1."]);
const timeout = (file: string) => [`##[group]${file}:`, "(fail) slow > case [5000.00ms]", "  ^ this test timed out after 5000ms.", "##[endgroup]"];
const asserted = (file: string) => [`##[group]${file}:`, "error: expect(received).toBe(expected)", "(fail) race > case [0.40ms]", "##[endgroup]"];
const tests = (groups: string[][]) => step(SHARD, "Unit tests", [...groups.flat(), " 1999 pass", ` ${groups.length} fail`, "##[error]Process completed with exit code 1."]);
const install = step(SHARD, "Install dependencies", ["bun install v1.3.0", "error: ConnectionRefused downloading tarball zod@4.6.5", "##[error]Process completed with exit code 1."]);
const shutdown = step(SHARD, "Unit tests", ["##[group]tests/a.test.ts:", "(pass) a", "##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped.",
  "##[error]The operation was canceled."]);
const none = new Set<string>();

describe("[验收线 1] classes that may earn one re-run", () => {
  test("every failure a timeout outside the changed files → timeout, with its files and cases", () => {
    expect(classifyFailedLog(log(tests([timeout("tests/b.test.ts"), timeout("tests/a.test.ts")]), gate), new Set(["src/lib/x.ts"])))
      .toEqual({ kind: "timeout", files: ["tests/a.test.ts", "tests/b.test.ts"], cases: ["tests/b.test.ts > slow > case", "tests/a.test.ts > slow > case"] });
  });
  test("a non-timeout failure outside the changed files → known_flaky candidate (a timeout next to it rides along)", () => {
    expect(classifyFailedLog(log(tests([asserted("tests/flaky.test.ts"), timeout("tests/a.test.ts")])), none))
      .toEqual({ kind: "known_flaky", files: ["tests/a.test.ts", "tests/flaky.test.ts"] });
  });
  test("a network error in an install / download step, a runner shutdown in a step without test failures → env with signature and step", () => {
    expect(classifyFailedLog(log(install, gate), none)).toEqual({ kind: "env", signature: "安装/下载失败：ConnectionRefused", step: `${SHARD} / Install dependencies` });
    const fetched = classifyFailedLog(log(step("web production build", "Run actions/setup-node@v4", ["##[error]connect ETIMEDOUT 140.82.112.3:443"])), none);
    expect(fetched).toMatchObject({ kind: "env", signature: "安装/下载失败：ETIMEDOUT" });
    expect(classifyFailedLog(log(shutdown), none)).toMatchObject({ kind: "env", step: `${SHARD} / Unit tests` });
    expect((classifyFailedLog(log(shutdown), none) as { signature: string }).signature).toStartWith("runner 中断：The runner has received a shutdown signal");
  });
});

describe("[验收线 2] every doubt is code or unknown", () => {
  test("a failing test file among the changed files → code, timeout or not", () => {
    expect(classifyFailedLog(log(tests([timeout("tests/a.test.ts")])), new Set(["tests/a.test.ts"]))).toEqual({ kind: "code", why: "失败的测试文件 tests/a.test.ts 在改动里" });
    expect(classifyFailedLog(log(tests([asserted("tests/flaky.test.ts")])), new Set(["tests/flaky.test.ts"])).kind).toBe("code");
  });
  test("an environment signature next to any other failed step → code (mixed), never env", () => {
    expect(classifyFailedLog(log(install, tests([asserted("tests/a.test.ts")]), gate), none)).toEqual({ kind: "code", why: "环境故障签名之外还有别的失败步骤（混合红）" });
    expect(classifyFailedLog(log(install, step("web typecheck + lint", "Lint (eslint)", ["##[error]Process completed with exit code 1."])), none).kind).toBe("code");
  });
  test("a network word outside a fetch step, a runner shutdown after a test failure, a failed typecheck, an empty log → not env", () => {
    const netInTest = step(SHARD, "Unit tests", ["##[group]tests/a.test.ts:", "error: ECONNRESET", "(fail) fetches [1.00ms]", "##[endgroup]", " 1 fail",
      "##[error]Process completed with exit code 1."]);
    expect(classifyFailedLog(log(netInTest), none)).toEqual({ kind: "known_flaky", files: ["tests/a.test.ts"] }); // a test's own failure; the list decides
    const failedThenShutdown = step(SHARD, "Unit tests", ["##[group]tests/a.test.ts:", "(fail) a [1.00ms]", "##[endgroup]",
      "##[error]The runner has received a shutdown signal."]);
    expect(classifyFailedLog(log(failedThenShutdown), none).kind).toBe("unknown");
    expect(classifyFailedLog(log(step(SHARD, "Typecheck (tsc --noEmit)", ["src/x.ts(1,1): error TS2322: no", "##[error]Process completed with exit code 2."])), none).kind).toBe("unknown");
    expect(classifyFailedLog(log(step(SHARD, "Install dependencies", ["error: lockfile had changes, but lockfile is frozen", "##[error]Process completed with exit code 1."])), none).kind)
      .toBe("unknown");
    expect(classifyFailedLog("", none).kind).toBe("unknown");
    expect(classifyFailedLog(log(gate), none).kind).toBe("unknown"); // the gate's verdict alone names no failure
  });
  test("a runner fault next to a code failure in its own step (no `(fail)` line needed) → never env", () => {
    const cut = (ls: string[]) => classifyFailedLog(log(step(SHARD, "Unit tests", ["##[group]tests/a.test.ts:", "(pass) handles an error", ...ls,
      "##[error]The runner has received a shutdown signal."])), new Set(["tests/changed.test.ts"])).kind;
    expect(cut(["error: Cannot find module './gone' from 'tests/changed.test.ts'", "# Unhandled error between tests"])).toBe("unknown");
    expect(cut(["SyntaxError: Unexpected token"])).toBe("unknown");
    expect(cut(["error: expect(received).toBe(expected)"])).toBe("unknown");
    expect(cut(["src/x.ts(1,1): error TS2322: no"])).toBe("unknown");
    expect(cut(["##[error]Process completed with exit code 1."])).toBe("unknown"); // the step's own exit, not the runner's kill
    expect(cut(["##[error]Process completed with exit code 143.", "##[error]The operation was canceled."])).toBe("env");
    expect(cut([])).toBe("env");
  });
  test("an install step: a second error next to the network one, or a change that holds an install / CI input → never env", () => {
    const both = step(SHARD, "Install dependencies", ["error: ConnectionRefused downloading tarball zod@4.6.5", "error: lockfile had changes, but lockfile is frozen",
      "##[error]Process completed with exit code 1."]);
    expect(classifyFailedLog(log(both), none).kind).toBe("unknown");
    for (const f of ["package.json", "web/package.json", "bun.lock", ".github/workflows/ci.yml"]) {
      expect(classifyFailedLog(log(install, gate), new Set(["src/a.ts", f]))).toEqual({ kind: "code", why: `环境故障签名，但改动里有决定安装 / CI 的文件 ${f}` });
      expect(classifyFailedLog(log(shutdown), new Set([f])).kind).toBe("code");
    }
    expect(classifyFailedLog(log(install, gate), new Set(["src/package.json.ts"])).kind).toBe("env");
  });
  test("the gate step with anything but its verdict is a failed step of its own", () => {
    const odd = step(GATE, "All shards succeeded", ["##[error]分片没有全部成功：failure", "##[error]something else"]);
    expect(classifyFailedLog(log(install, odd), none).kind).toBe("code");
  });
});

describe("[验收线 4] the helpers the serial gate (CIF1 / CIF8) calls", () => {
  const failures = [{ file: "tests/a.test.ts", name: "a", timedOut: true }, { file: "tests/b.test.ts", name: "b", timedOut: false }];
  test("firstAsserted = the first non-timeout failure; firstTouched = the first failure in a changed file", () => {
    expect(firstAsserted(failures)?.name).toBe("b");
    expect(firstAsserted(failures.slice(0, 1))).toBeUndefined();
    expect(firstTouched(failures, new Set(["tests/b.test.ts"]))?.file).toBe("tests/b.test.ts");
    expect(firstTouched(failures, new Set(["src/lib/x.ts"]))).toBeUndefined();
  });
});
