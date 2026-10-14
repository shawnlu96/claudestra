/**
 * merge-arch-CISEL1 [验收线 2]: the pure release verdict (src/lib/ci-selected-verdict.ts). A failure outside both the frozen
 * responsibility and the PR's changes is released; inside the responsibility, inside the changes, an incomplete parse, an "all"
 * responsibility, a red non-test step or a shard that did not run to the end each keep the shard red. Plus the shard-log reading
 * the shard script feeds it with (parseFailedLog of scheduler-merge-ci-rerun-log.ts over the shard's own log).
 */
import { describe, expect, test } from "bun:test";
import {
  ciSelectedMode, hasBunFailures, judgeSelected, parseReceipt, responsibility, type SelectedVerdictInput, shardComplete, shardLogFailures,
} from "../src/lib/ci-selected-verdict.js";
import type { CiFailure } from "../src/lib/scheduler-merge-ci-rerun-log.js";

const fail = (file: string, name = "case", timedOut = false): CiFailure => ({ file, name, timedOut });
const STEPS = { typecheck: "success", guard: "pending", build: "pending", "web-build": "pending" };
const base = (over: Partial<SelectedVerdictInput> = {}): SelectedVerdictInput => ({
  responsibility: responsibility(["tests/mine.test.ts"]), failures: [fail("tests/flaky.test.ts", "loads under load", true)],
  changed: ["src/lib/mine.ts", "tests/mine.test.ts"], complete: true, steps: STEPS, ...over,
});

describe("[验收线 2] judgeSelected", () => {
  test("a failure outside the responsibility and outside the PR's changes is released, listed once", () => {
    const v = judgeSelected(base({ failures: [fail("tests/flaky.test.ts"), fail("./tests/flaky.test.ts"), fail("tests/other.test.ts", "b")] }));
    expect(v).toEqual({ allow: true, reason: "2 条失败都在责任选集与改动之外",
      outOfScope: [{ file: "tests/flaky.test.ts", name: "case" }, { file: "tests/other.test.ts", name: "b" }] });
  });

  test("a failure in the responsibility is not released", () => {
    expect(judgeSelected(base({ failures: [fail("tests/flaky.test.ts"), fail("tests/mine.test.ts")] })))
      .toEqual({ allow: false, reason: "失败在责任选集里：tests/mine.test.ts", outOfScope: [] });
  });

  test("a failure in a file the PR changed is not released, even when the selector left it out", () => {
    const v = judgeSelected(base({ responsibility: responsibility([]), changed: ["tests/flaky.test.ts"] }));
    expect(v).toMatchObject({ allow: false, reason: "失败在 PR 改动里：tests/flaky.test.ts" });
  });

  test("an incomplete parse (null), no attributable failure, or a failure that is not a test file is not released", () => {
    expect(judgeSelected(base({ failures: null }))).toMatchObject({ allow: false, reason: "失败日志解析不全" });
    expect(judgeSelected(base({ failures: [] }))).toMatchObject({ allow: false });
    expect(judgeSelected(base({ failures: [fail("src/lib/x.ts")] }))).toMatchObject({ allow: false, reason: "失败归属不到测试文件：src/lib/x.ts" });
  });

  test("an \"all\" responsibility (any full fallback, main, a train) or none at all is not released", () => {
    expect(judgeSelected(base({ responsibility: responsibility("all", ["列车 PR 始终全量"]) })))
      .toMatchObject({ allow: false, reason: "责任选集是 all（列车 PR 始终全量）" });
    expect(judgeSelected(base({ responsibility: null }))).toMatchObject({ allow: false, reason: "没有可核对的责任选集" });
  });

  test("a red non-test step (typecheck, guard, entry build, web build) is not released", () => {
    for (const step of ["typecheck", "guard", "build", "web-build"]) {
      for (const outcome of ["failure", "cancelled", ""]) {
        expect(judgeSelected(base({ steps: { ...STEPS, [step]: outcome } })).allow).toBe(false);
      }
    }
    expect(judgeSelected(base({ steps: { ...STEPS, typecheck: "skipped" } })).allow).toBe(true);
  });

  test("a shard that did not run to the end, unknown changes, or a PR that edits the verdict itself is not released", () => {
    expect(judgeSelected(base({ complete: false }))).toMatchObject({ allow: false, reason: "选中测试没有完整跑完" });
    expect(judgeSelected(base({ changed: null }))).toMatchObject({ allow: false, reason: "读不出 PR 改动" });
    expect(judgeSelected(base({ changed: ["src/lib/ci-selected-verdict.ts"] }))).toMatchObject({ allow: false, reason: "PR 改了放行判定本身：src/lib/ci-selected-verdict.ts" });
  });
});

/** What bun writes into shard.log on a runner (the shard step's own tee), before gh ever prefixes it. */
const shardLog = (groups: [string, string[]][], fails: number, tail = true) => [
  "shard=3/8", `head=${"a".repeat(40)}`, "discovered=40", "bun test v1.3.14 (0d9b296a)", "",
  ...groups.flatMap(([file, lines]) => [`::group::${file}:`, ...lines, "::endgroup::"]),
  ...(tail ? [" 12 pass", ` ${fails} fail`, "Ran 13 tests across 2 files. [9.00ms]"] : []),
].join("\n");

describe("the shard log the verdict reads", () => {
  const log = shardLog([["tests/a.test.ts", ["(pass) a [1.00ms]", "printed\twith\ttabs"]],
    ["tests/flaky.test.ts", ["::error file=tests/flaky.test.ts,line=3::expect(received).toBe(expected)", "(fail) under load [5001.00ms]"]]], 1);

  test("bun's own groups, error annotations and fails parse to failures with their file (tabs in test output stay text)", () => {
    expect(shardLogFailures(log, 3)).toEqual([{ file: "tests/flaky.test.ts", name: "under load", timedOut: false }]);
    expect(shardLogFailures(log.replace(" 1 fail", " 2 fail"), 3)).toBeNull(); // the total does not match: incomplete
    expect(shardLogFailures(log.replace("(fail) under load [5001.00ms]", ""), 3)).toBeNull(); // an error nobody claims
    expect(shardLogFailures(`${log}\nerror: Cannot find module "x"`, 3)).toBeNull();
  });

  test("complete = bun exited 1 for failing tests, reached its summary line, and ran exactly the assigned files", () => {
    const assigned = ["./tests/a.test.ts", "./tests/flaky.test.ts"];
    expect(shardComplete(log, assigned, 1)).toBe(true);
    expect(shardComplete(log, assigned, 137)).toBe(false);
    expect(shardComplete(log, [...assigned, "./tests/never.test.ts"], 1)).toBe(false);
    expect(shardComplete(shardLog([["tests/a.test.ts", ["(pass) a"]]], 1, false), ["./tests/a.test.ts"], 1)).toBe(false);
  });

  test("a red bun summary is told apart from a green one", () => {
    expect([hasBunFailures(log), hasBunFailures(log.replace(" 1 fail", " 0 fail"))]).toEqual([true, false]);
  });

  test("only bun's closing summary counts: a passing test that prints \" 1 fail\" (or a fake summary) before it is still green", () => {
    const printed = shardLog([["tests/a.test.ts", [" 1 fail", " 3 error", "Ran 1 test across 1 file.", "(pass) prints fail text [1.00ms]"]]], 0);
    expect(hasBunFailures(printed)).toBe(false);
    expect(hasBunFailures(printed.replace(" 0 fail", " 0 fail\n 1 error"))).toBe(true); // an unhandled error between tests is red too
    expect(hasBunFailures("ok\n 1 fail")).toBe(false); // no closing summary at all: never ran to the end, nothing released
  });
});

describe("the mode and the receipt shape", () => {
  test("only an explicit off / on is honoured; unset, observe and anything else read observe", () => {
    expect(["off", "ON", "", undefined, "observe", "yes"].map(ciSelectedMode)).toEqual(["off", "on", "observe", "observe", "observe", "observe"]);
  });

  test("a receipt that claims applied without on + allow + a responsibility digest, or has an unknown field, does not parse", () => {
    const r = { version: 1, kind: "ci-selected-shard", mode: "on", shard: 1, runId: 9, attempt: 1, head: "a".repeat(40), planDigest: "p",
      responsibilityDigest: `sha256:${"1".repeat(64)}`, logDigest: `sha256:${"0".repeat(64)}`, exitCode: 1, allow: true, applied: true, reason: "", outOfScope: [] };
    expect(parseReceipt(r)).not.toBeNull();
    expect(parseReceipt({ ...r, mode: "observe" })).toBeNull();
    expect(parseReceipt({ ...r, allow: false })).toBeNull();
    expect(parseReceipt({ ...r, extra: 1 })).toBeNull();
    expect(parseReceipt({ ...r, responsibilityDigest: null })).toBeNull();
    expect(parseReceipt({ ...r, responsibilityDigest: null, allow: false, applied: false })).not.toBeNull();
  });
});
