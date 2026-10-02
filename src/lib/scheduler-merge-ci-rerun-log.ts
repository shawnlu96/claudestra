/**
 * Reads `gh run view <run> --log-failed` of a bun test job (i28-CIF1). Anything it cannot account for is a parse failure (null),
 * never "no failures": the caller then bounces the card to fix as before, so a log shape this file does not know can only
 * cost a re-run, never wave a real failure through. tests/scheduler-merge-ci-rerun.test.ts.
 */

export interface CiFailure { file: string; name: string; timedOut: boolean }

/** gh prefixes each line with `job<TAB>step<TAB>`, then the runner's ISO timestamp. */
const PREFIX = /^([^\t]*)\t([^\t]*)\t/;
const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const GROUP = /^##\[group\](\S+\.test\.[cm]?[jt]sx?):\s*$/;
/** bun prints `(fail) describe > name [6189.00ms]`; the timing is dropped so a repeated summary line matches its group entry. */
const FAIL = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/;
const TIMED_OUT = /^\s*\^ this test timed out after \d+ms\.?\s*$/;
const FAIL_COUNT = /^\s*(\d+) fail\s*$/;
/** Errors outside any test (a crashed file, an unhandled rejection) are red without a `(fail)` line of their own. */
const OUTSIDE_TEST = /error between tests|Unhandled error|^error: .*(?:Cannot find module|SyntaxError)/i;
/** Any error bun or the runner prints; inside a file group it belongs to the next `(fail)`, anywhere else it is unaccounted. */
const ERROR = /^\s*(?:error:|##\[error\]|panic\b)/i;
/** The one runner error every red bun step ends with. */
const STEP_EXIT = /^##\[error\]Process completed with exit code \d+\.?\s*$/;

function stripLines(log: string): { lines: string[]; steps: Set<string> } | null {
  const steps = new Set<string>();
  const lines: string[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const p = PREFIX.exec(raw);
    if (p) steps.add(`${p[1]}\t${p[2]}`);
    lines.push((p ? raw.slice(p[0].length) : raw).replace(STAMP, ""));
  }
  return lines.some((l) => l.trim()) ? { lines, steps } : null;
}

const nextText = (lines: string[], from: number): string => lines.slice(from).find((l) => l.trim()) ?? "";

/**
 * Every `(fail)` of the log with its test file (the `##[group]tests/x.test.ts:` it sits in) and whether bun said it timed out.
 * Null when: the log is empty, spans more than one failed step, has a failure outside a file group that is not a repeat of one
 * inside, an error outside any test, an `error:` in a file group that no `(fail)` of that group claims, any error line outside
 * the file groups other than the step's exit code, no `N fail` total, or a total that differs from the failures found.
 * A `(fail)` with an `error:` printed for it is not a timeout, whatever follows it.
 */
export function parseFailedLog(log: string): CiFailure[] | null {
  const stripped = stripLines(log);
  if (!stripped || stripped.steps.size > 1) return null;
  const { lines } = stripped;
  const found: CiFailure[] = [];
  const totals: number[] = [];
  let file: string | null = null;
  let errored = false; // an error line in this group not yet claimed by a `(fail)`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (OUTSIDE_TEST.test(line)) return null;
    const group = GROUP.exec(line);
    if (group) {
      if (errored) return null;
      file = group[1]!;
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
    const fail = FAIL.exec(line);
    if (!fail) continue;
    const name = fail[1]!;
    if (!file) {
      if (!found.some((f) => f.name === name)) return null; // bun's closing recap repeats earlier failures; a new one is unaccounted
      continue;
    }
    if (found.some((f) => f.file === file && f.name === name)) continue;
    found.push({ file, name, timedOut: !errored && TIMED_OUT.test(nextText(lines, i + 1)) });
    errored = false;
  }
  if (errored || !found.length || totals.length !== 1 || totals[0] !== found.length) return null;
  return found;
}
