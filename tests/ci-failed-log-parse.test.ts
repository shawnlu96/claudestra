/**
 * dispatch-recovery-CIPARSE1: a test title is a name, not an error. bun's result lines (`(pass) ` / `(fail) ` / `(skip) ` /
 * `(todo) ` at the very start of the line) are no longer read as "an error outside any test"; every other line still is.
 * The logs are generated here in the shape of a real `gh run view --log-failed` of a red shard (job, step, file groups, result
 * lines, bun's closing totals); test names are placeholders, only the triggering words are kept.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFailedLog, firstAsserted, firstTouched } from "../src/lib/ci-failure-class.js";
import { isResultLine, parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";

const JOB = "test shard 3 of 4", STEP = "Unit tests";
const QUIET_FILE = "tests/placeholder-quiet.test.ts", RED_FILE = "tests/placeholder-red.test.ts";
/** The two lines the parameterized case prints in CI: its own result line and the one of the `observe` variant. */
const TITLES = ["(pass) [mark] suite > on: a shutdown in a step that also holds an import error and an error between tests → no rerun [0.21ms]",
  "(pass) [mark] suite > observe: a shutdown in a step that also holds an import error and an error between tests → no rerun [0.18ms]"];
const group = (file: string, lines: string[]) => [`##[group]${file}:`, ...lines, "##[endgroup]"];
const ASSERTED = ["error: expect(received).toBe(expected)", "Expected: 1", "Received: 2", "(fail) suite > case one [0.40ms]"];
const TIMED_OUT = ["(fail) suite > case one [5001.00ms]", "  ^ this test timed out after 5000ms."];
/** One red shard step: a quiet group, the red group, then bun's recap and totals and the runner's exit line. */
function shardLog(o: { quiet?: string[]; red?: string[]; recap?: string[]; fails?: number } = {}): string {
  const lines = ["bun test v1.3.0 (placeholder)", "", ...group(QUIET_FILE, ["(pass) suite > plain case [0.10ms]", ...(o.quiet ?? [])]),
    ...group(RED_FILE, o.red ?? ASSERTED), "", `${o.fails ?? 1} tests failed:`, ...(o.recap ?? ["(fail) suite > case one [0.40ms]"]), "",
    " 1999 pass", " 3 skip", ` ${o.fails ?? 1} fail`, " 4321 expect() calls", "Ran 2003 tests across 2 files. [41.00s]", "##[error]Process completed with exit code 1."];
  return lines.map((l, i) => `${JOB}\t${STEP}\t2026-10-13T21:02:${String(i % 60).padStart(2, "0")}.1234567Z ${l}`).join("\n");
}
const ONE = [{ file: RED_FILE, name: "suite > case one", timedOut: false }];

describe("[验收线 1] a result line's title is not an error outside a test", () => {
  test("the result-line rule: only the marker at the very start of the line", () => {
    for (const l of ["(pass) a", "(fail) a [1.00ms]", "(skip) a", "(todo) a"]) expect(isResultLine(l)).toBe(true);
    for (const l of [" (pass) a", "\t(fail) a", "(pass)", "(passed) a", "x (skip) a", "# Unhandled error between tests", ""]) expect(isResultLine(l)).toBe(false);
  });
  test("two (pass) titles holding `an import error and an error between tests` → the one asserted failure, as without them", () => {
    const without = parseFailedLog(shardLog());
    expect(without).toEqual(ONE);
    expect(parseFailedLog(shardLog({ quiet: TITLES }))).toEqual(without);
  });
  test("(skip) / (todo) titles holding `Unhandled error` change nothing either", () => {
    expect(parseFailedLog(shardLog({ quiet: ["(skip) suite > reports an Unhandled error", "(todo) suite > Unhandled error between tests is surfaced"] }))).toEqual(ONE);
  });
  test("a (fail) title holding `Unhandled error` is one failure; timeout or not is decided as before", () => {
    const name = "suite > survives an Unhandled error between tests";
    const asserted = shardLog({ red: ["error: expect(received).toBe(expected)", `(fail) ${name} [0.40ms]`], recap: [`(fail) ${name} [0.40ms]`] });
    expect(parseFailedLog(asserted)).toEqual([{ file: RED_FILE, name, timedOut: false }]);
    const slow = shardLog({ red: [`(fail) ${name} [5001.00ms]`, "  ^ this test timed out after 5000ms."], recap: [`(fail) ${name} [5001.00ms]`] });
    expect(parseFailedLog(slow)).toEqual([{ file: RED_FILE, name, timedOut: true }]);
    // the rest of the (fail) handling is untouched: a recap naming a failure no group holds, or a total that disagrees, is still unaccounted
    expect(parseFailedLog(shardLog({ recap: [`(fail) ${name} [0.40ms]`] }))).toBeNull();
    expect(parseFailedLog(shardLog({ quiet: TITLES, fails: 2 }))).toBeNull();
  });
});

describe("[验收线 2] a real error outside a test is still unparseable", () => {
  const cases: Array<[string, string[]]> = [
    ["`# Unhandled error between tests` at the start of a line", ["", "# Unhandled error between tests", ""]],
    ["`error: Cannot find module`", ["error: Cannot find module './gone' from 'tests/placeholder-quiet.test.ts'"]],
    ["`Unhandled error` in a line that is not a result line", ["Unhandled error: placeholder went wrong"]],
    ["an indented `(pass)` a test printed itself", [" (pass) suite > an import error and an error between tests [0.21ms]"]],
    ["a result line followed by the real `# Unhandled error between tests`", [...TITLES, "# Unhandled error between tests"]],
  ];
  test.each(cases)("%s → null", (_what, quiet) => {
    expect(parseFailedLog(shardLog({ quiet }))).toBeNull();
    expect(classifyFailedLog(shardLog({ quiet }), new Set()).kind).toBe("unknown");
  });
  test("the same lines outside every file group → null", () => {
    for (const l of ["# Unhandled error between tests", "Unhandled error: placeholder went wrong"]) {
      expect(parseFailedLog(shardLog({ quiet: TITLES, recap: ["(fail) suite > case one [0.40ms]", l] }))).toBeNull();
    }
  });
});

describe("[验收线 3] the verdict end to end", () => {
  const log = shardLog({ quiet: TITLES });
  test("the failing file outside the change → known_flaky candidate, no longer unknown", () => {
    expect(classifyFailedLog(log, new Set(["src/lib/placeholder.ts"]))).toEqual({ kind: "known_flaky", files: [RED_FILE] });
  });
  test("the failing file in the change → code", () => {
    expect(classifyFailedLog(log, new Set([RED_FILE]))).toEqual({ kind: "code", why: `失败的测试文件 ${RED_FILE} 在改动里` });
  });
  test("a timeout stays a timeout", () => {
    expect(classifyFailedLog(shardLog({ quiet: TITLES, red: TIMED_OUT, recap: ["(fail) suite > case one [5001.00ms]"] }), new Set()))
      .toEqual({ kind: "timeout", files: [RED_FILE], cases: [`${RED_FILE} > suite > case one`] });
  });
});

/**
 * merge-arch-CIUNREL1: PR1593's real red shard (run 38745600454 attempt 1, job 116466116858, shard 7), cut to the failing group,
 * bun's recap and totals (tests/fixtures/ci-log-timeout-pr1593-*.txt; gh printed every step as `UNKNOWN STEP`). Two things made it
 * unparseable: the timed-out test's abandoned promise rejected later as an "Unhandled error between tests" in the same file, and
 * the gate job read whole (UNKNOWN STEP) was not recognized as the gate's verdict.
 */
describe("[验收线 1] PR1593: a timeout plus its own unhandled error parses as one timed-out failure", () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `ci-log-timeout-pr1593-${name}.txt`), "utf8");
  const SHARD = fixture("shard"), GATE_JOB = fixture("gate");
  const FILE = "tests/lend-pr-takeover-preflight.test.ts", NAME = "real CLI rereads spec after remote await and writes no stale diagnostic";
  const PR1593 = [{ file: FILE, name: NAME, timedOut: true, strays: 1 }];
  const edit = (log: string, from: RegExp, to: string) => { expect(from.test(log)).toBe(true); return log.replace(from, to); };

  test("the shard log: 1 failure, a timeout, its test file; the recap's repeat counts once; CIF1 would re-run it", () => {
    const failures = parseFailedLog(SHARD);
    expect(failures).toEqual(PR1593);
    expect(firstAsserted(failures!)).toBeUndefined(); // CIF1: every failure timed out
    expect(firstTouched(failures!, new Set(["src/lib/x.ts"]))).toBeUndefined();
    expect(classifyFailedLog(SHARD, new Set())).toEqual({ kind: "timeout", files: [FILE], cases: [`${FILE} > ${NAME}`] });
  });
  test("the whole run's log: the gate job read whole (UNKNOWN STEP) is the gate's verdict, skipped", () => {
    expect(parseFailedLog(`${SHARD}\n${GATE_JOB}`)).toEqual(PR1593);
    expect(classifyFailedLog(`${SHARD}\n${GATE_JOB}`, new Set()).kind).toBe("timeout");
  });
  test("cut logs still refuse: no totals, the error block cut before its closing rule, or bun's error total missing", () => {
    expect(parseFailedLog(SHARD.split("\n").filter((l) => !/Z +\d+ (?:fail|error)\s*$/.test(l)).join("\n"))).toBeNull();
    const lines = SHARD.split("\n"), rules = lines.flatMap((l, i) => (/Z -{10,}\s*$/.test(l) ? [i] : []));
    expect(rules.length).toBe(2);
    expect(parseFailedLog(lines.slice(0, rules[1]).join("\n"))).toBeNull(); // cut inside the error block
    expect(parseFailedLog(lines.filter((_, i) => i !== rules[1]).join("\n"))).toBeNull(); // the block never closes
    expect(parseFailedLog(edit(SHARD, /Z  1 error\n/, "Z \n"))).toBeNull();
    expect(parseFailedLog(edit(SHARD, /Z  1 error\n/, "Z  2 error\n"))).toBeNull();
  });
  test("a timeout mixed with an assertion stays mixed: CIF1 refuses, the class is not timeout", () => {
    const row = (t: string) => `test shard 7 of 8\tUNKNOWN STEP\t2026-10-15T14:18:26.0000000Z ${t}`;
    const mixed = edit(edit(edit(SHARD, /\n(?=[^\n]*\(pass\) real CLI rereads round)/, `\n${row("error: expect(received).toBe(expected)")}\n${row("(fail) real CLI asserted [1.00ms]")}\n`),
      /Z  1 fail\n/, "Z  2 fail\n"), /Z 1 tests failed:\n/, `Z 2 tests failed:\n${row("(fail) real CLI asserted [1.00ms]")}\n`);
    const failures = parseFailedLog(mixed);
    expect(failures?.map((f) => f.timedOut)).toEqual([true, false]);
    expect(firstAsserted(failures!)?.name).toBe("real CLI asserted");
    expect(classifyFailedLog(mixed, new Set()).kind).toBe("known_flaky");
  });
  test("an unhandled error is only a timeout's own: no timeout before it, or a stack frame elsewhere → unparseable", () => {
    expect(parseFailedLog(edit(SHARD, /\n[^\n]*\^ this test timed out after 15000ms\./, ""))).toBeNull(); // the group's failure is no timeout
    expect(parseFailedLog(edit(SHARD, /tests\/lend-pr-takeover-preflight\.test\.ts:352:25\)/, "src/lib/elsewhere.ts:1:1)"))).toBeNull();
    expect(parseFailedLog(edit(SHARD, /at async <anonymous> \(\/home[^\n]*/, "at processTicksAndRejections (native:7:39)"))).toBeNull();
  });
  test("the gate job read whole refuses any other failure in it", () => {
    expect(parseFailedLog(`${SHARD}\n${GATE_JOB.replace("Cleaning up orphan processes", "##[error]Something else failed")}`)).toBeNull();
    expect(parseFailedLog(`${SHARD}\n${GATE_JOB.replace(/(\t\S+ )##\[error\]Process completed with exit code 1\./, "$1(fail) a test here")}`)).toBeNull();
  });
});
