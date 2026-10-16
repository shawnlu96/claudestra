/**
 * Reads `gh run view <run> --log-failed` of a bun test job (i28-CIF1). Anything it cannot account for is a parse failure (null),
 * never "no failures": the caller then bounces the card to fix as before, so a log shape this file does not know can only
 * cost a re-run, never wave a real failure through. tests/scheduler-merge-ci-rerun.test.ts.
 */

/**
 * `strays`: bun's "Unhandled error between tests" blocks this timed-out test left behind in its own file (merge-arch-CIUNREL1):
 * the test's promise is abandoned at the timeout and rejects later. Only on a timed-out failure; absent when there are none.
 */
export interface CiFailure { file: string; name: string; timedOut: boolean; strays?: number }

/** gh prefixes each line with `job<TAB>step<TAB>`, then the runner's ISO timestamp. */
export const PREFIX = /^([^\t]*)\t([^\t]*)\t/;
export const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
export const GROUP = /^##\[group\](\S+\.test\.[cm]?[jt]sx?):\s*$/;
/** bun prints `(fail) describe > name [6189.00ms]`; the timing is dropped so a repeated summary line matches its group entry. */
export const FAIL = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/;
export const TIMED_OUT = /^\s*\^ this test timed out after \d+ms\.?\s*$/;
export const FAIL_COUNT = /^\s*(\d+) fail\s*$/;
/** bun's total of errors outside any test (unhandled errors between tests). */
export const ERROR_COUNT = /^\s*(\d+) errors?\s*$/;
/** bun's frame around one unhandled error between tests: the title line, then a rule, the error, a closing rule. */
export const UNHANDLED = /^# Unhandled error between tests\s*$/;
const RULE = /^-{10,}\s*$/;
/** One stack frame with its source path: `at fn (path:line:col)` or `at path:line:col`. */
const FRAME = /^\s*at (?:.*? \(([^()\s]+):\d+:\d+\)|([^()\s]+):\d+:\d+)\s*$/;
/** Errors outside any test (a crashed file, an unhandled rejection) are red without a `(fail)` line of their own. */
export const OUTSIDE_TEST = /error between tests|Unhandled error|^error: .*(?:Cannot find module|SyntaxError)/i;
/**
 * bun's own result line for one test: the marker at the very start of the line (gh prefix and timestamp already dropped), then
 * the test's title. The title is a name, not output: it is never read as an error outside a test (dispatch-recovery-CIPARSE1).
 * An indented `(pass) ` is text a test printed itself and is not one. tests/ci-failed-log-parse.test.ts.
 */
const RESULT_LINE = /^\((?:pass|fail|skip|todo)\) /;
export const isResultLine = (line: string): boolean => RESULT_LINE.test(line);
/** Any error bun or the runner prints; inside a file group it belongs to the next `(fail)`, anywhere else it is unaccounted. */
export const ERROR = /^\s*(?:error:|##\[error\]|panic\b)/i;
/** The one runner error every red bun step ends with. */
export const STEP_EXIT = /^##\[error\]Process completed with exit code \d+\.?\s*$/;

/**
 * The sharded workflow's gate (ci.yml job `typecheck + test + guard`, step `All shards succeeded`) fails with exactly this when a
 * shard did not succeed; the shard's own step carries the failures, so that one step is skipped. Only that job + step, and only
 * the runner's `Run` echo block plus this line and the exit code: any other text there (or the line in any other step) is read
 * as a failed step and makes the log unaccountable.
 */
export const GATE = { job: "typecheck + test + guard", step: "All shards succeeded" };
export const GATE_VERDICT = /^##\[error\]分片没有全部成功：\w+\s*$/;
const RUN_ECHO = "##[group]Run ";
/**
 * The runner echoes that step's own command (ci.yml) and its shell inside the Run group; nothing else may sit there.
 * The command copy is colored, and gh prints the ESC of that color as the two characters `^[`.
 */
const GATE_COMMAND = /^\[ "\w+" = success \] \|\| \{ echo "::error::分片没有全部成功：\w+"; exit 1; \}$/;
const isGateEcho = (line: string): boolean => /^shell: \/usr\/bin\/bash -e \{0\}$/.test(line) ||
  GATE_COMMAND.test(line.replace(/^(?:\u001b|\^\[)\[36;1m/, "").replace(/(?:\u001b|\^\[)\[0m$/, ""));

interface FailedStep { job: string; step: string; lines: string[] }

/** Lines without the gh prefix and timestamp, grouped by failed step; unprefixed lines stay with the step before. */
function stepLines(log: string): FailedStep[] | null {
  const steps = new Map<string, FailedStep>();
  let key = "";
  for (const raw of log.split(/\r?\n/)) {
    const p = PREFIX.exec(raw);
    if (p) key = `${p[1]}\t${p[2]}`;
    const step = steps.get(key) ?? steps.set(key, { job: p?.[1] ?? "", step: p?.[2] ?? "", lines: [] }).get(key)!;
    step.lines.push((p ? raw.slice(p[0].length) : raw).replace(STAMP, ""));
  }
  const real = [...steps.values()].filter((s) => s.lines.some((l) => l.trim()));
  return real.length ? real : null;
}

/** gh prints this step name when it cannot split a job's log by step (seen 10-15 on PR1593): the whole job is one "step". */
export const UNKNOWN_STEP = "UNKNOWN STEP";

function isGateVerdict(s: FailedStep): boolean {
  if (s.job === GATE.job && s.step === UNKNOWN_STEP) return isWholeGateJob(s.lines);
  if (s.job !== GATE.job || s.step !== GATE.step) return false;
  let inEcho = false;
  let verdict = false;
  for (const line of s.lines) {
    if (inEcho) {
      if (line.startsWith("##[endgroup]")) inEcho = false;
      else if (!isGateEcho(line)) return false;
      continue;
    }
    if (line.startsWith(RUN_ECHO)) {
      if (!GATE_COMMAND.test(line.slice(RUN_ECHO.length))) return false;
      inEcho = true;
      continue;
    }
    if (GATE_VERDICT.test(line)) { verdict = true; continue; }
    if (line.trim() && !STEP_EXIT.test(line)) return false;
  }
  return verdict && !inEcho;
}

/**
 * The gate job read whole (UNKNOWN STEP): the runner's set-up and tear-down text around the gate step is allowed, but the gate
 * step's Run echo must read exactly as in the named step, then exactly one verdict and one step exit (one failed step in the job),
 * and no other error, failure, test result or failure total anywhere in the job (merge-arch-CIUNREL1).
 */
function isWholeGateJob(lines: string[]): boolean {
  let inEcho = false, echoes = 0, verdicts = 0, exits = 0;
  for (const line of lines) {
    if (inEcho) {
      if (line.startsWith("##[endgroup]")) inEcho = false;
      else if (!isGateEcho(line)) return false;
      continue;
    }
    if (line.startsWith(RUN_ECHO) && GATE_COMMAND.test(line.slice(RUN_ECHO.length))) { echoes++; inEcho = true; continue; }
    if (GATE_VERDICT.test(line)) { if (echoes !== 1) return false; verdicts++; continue; }
    if (STEP_EXIT.test(line)) { exits++; continue; }
    if (ERROR.test(line) || isResultLine(line) || OUTSIDE_TEST.test(line) || UNHANDLED.test(line) || FAIL_COUNT.test(line) ||
      ERROR_COUNT.test(line) || GROUP.test(line) || /^\s*error\b|::error::/i.test(line)) return false;
  }
  return !inEcho && echoes === 1 && verdicts === 1 && exits === 1;
}

/**
 * The end (closing rule) of an unhandled-error block starting at `at` that belongs to `file`, else null: the block is closed
 * before anything else of bun's starts, holds no test result or group, and every stack frame in it (at least one) is in `file`.
 */
function strayEnd(lines: string[], at: number, file: string): number | null {
  if (!RULE.test(lines[at + 1] ?? "")) return null;
  let frames = 0;
  for (let j = at + 2; j < lines.length; j++) {
    const line = lines[j]!;
    if (RULE.test(line)) return frames ? j : null;
    if (isResultLine(line) || UNHANDLED.test(line) || GROUP.test(line) || line.startsWith("##[endgroup]") || FAIL_COUNT.test(line)) return null;
    if (!/^\s*at /.test(line)) continue;
    const m = FRAME.exec(line);
    const path = m?.[1] ?? m?.[2];
    if (!path || (path !== file && !path.endsWith(`/${file}`))) return null;
    frames++;
  }
  return null; // cut before its closing rule
}

const nextText = (lines: string[], from: number): string => lines.slice(from).find((l) => l.trim()) ?? "";

/**
 * Every `(fail)` of the log with its test file (the `##[group]tests/x.test.ts:` it sits in) and whether bun said it timed out.
 * A sharded run fails one bun test step per red shard plus the gate's verdict step: each bun step is read on its own and the
 * verdict is skipped. Null when: the log is empty, has no bun step, or any failed step does not read as one bun test step.
 */
export function parseFailedLog(log: string): CiFailure[] | null {
  const steps = stepLines(log)?.filter((s) => !isGateVerdict(s));
  if (!steps?.length) return null;
  const found: CiFailure[] = [];
  for (const { lines } of steps) {
    const step = parseStep(lines);
    if (!step) return null;
    found.push(...step);
  }
  return found;
}

/**
 * One failed bun test step. Null when it has a failure outside a file group that is not a repeat of one inside, an error
 * outside any test, an `error:` in a file group that no `(fail)` of that group claims, any error line outside the file groups
 * other than the step's exit code, no `N fail` total, or a total that differs from the failures found.
 * A `(fail)` with an `error:` printed for it is not a timeout, whatever follows it.
 * The one error outside a test that is accounted (merge-arch-CIUNREL1, PR1593): an "Unhandled error between tests" block in a
 * file group after a timed-out `(fail)` of that group, closed, every stack frame in that same test file, counted on that timeout;
 * bun's `N error` total must then equal the blocks so accounted. Anywhere else, cut, or with a frame elsewhere, it stays null.
 */
function parseStep(lines: string[]): CiFailure[] | null {
  const found: CiFailure[] = [];
  const totals: number[] = [], errorTotals: number[] = [];
  let file: string | null = null;
  let errored = false; // an error line in this group not yet claimed by a `(fail)`
  let strays = 0, groupFrom = 0; // groupFrom: the first failure of the current file group
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (UNHANDLED.test(line)) {
      const timedOut = file && !errored ? found.slice(groupFrom).findLast((f) => f.timedOut) : undefined;
      const end = timedOut ? strayEnd(lines, i, file!) : null;
      if (!timedOut || end === null) return null;
      timedOut.strays = (timedOut.strays ?? 0) + 1;
      strays++;
      i = end;
      continue;
    }
    if (!isResultLine(line) && OUTSIDE_TEST.test(line)) return null;
    const group = GROUP.exec(line);
    if (group) {
      if (errored) return null;
      file = group[1]!;
      groupFrom = found.length;
      continue;
    }
    if (line.startsWith("##[endgroup]")) {
      if (errored) return null;
      file = null;
      continue;
    }
    if (ERROR.test(line)) {
      if (file) errored = true;
      else if (!STEP_EXIT.test(line)) return null;
      continue;
    }
    if (file && line.startsWith("(pass) ")) { errored = false; continue; } // a passing test's own console output
    const total = FAIL_COUNT.exec(line);
    if (total) { totals.push(Number(total[1])); continue; }
    const errorTotal = ERROR_COUNT.exec(line);
    if (errorTotal && !file) { errorTotals.push(Number(errorTotal[1])); continue; }
    const fail = FAIL.exec(line);
    if (!fail) continue;
    const name = fail[1]!;
    if (!file) {
      if (!found.some((f) => f.name === name)) return null; // bun's closing recap repeats earlier failures; a new one is unaccounted
      continue;
    }
    found.push({ file, name, timedOut: !errored && TIMED_OUT.test(nextText(lines, i + 1)) });
    errored = false;
  }
  if (errored || !found.length || totals.length !== 1 || totals[0] !== found.length) return null;
  // bun prints `N error` only when there were errors outside tests: it must be exactly the strays accounted above
  if (errorTotals.length > 1 || (errorTotals[0] ?? 0) !== strays) return null;
  return found;
}
