/** Keep original lines and parser state; large passing groups account for almost all of a shard's output. */
import { ERROR, FAIL, FAIL_COUNT, GATE, GATE_VERDICT, GROUP, OUTSIDE_TEST, PREFIX, STAMP, STEP_EXIT, TIMED_OUT, isResultLine } from "./scheduler-merge-ci-rerun-log.js";

const STEP_SMALL = 64 * 1024;
interface Line { raw: string; text: string; index: number; anchor: boolean }
interface Group { head: number; end?: number; clean: boolean; important: boolean; passes: number[] }

/** Parser-visible steps, with original indices so even interleaved steps remain an original-line subsequence. */
function stepsOf(raw: string[]): Map<string, Line[]> {
  const steps = new Map<string, Line[]>();
  let key = "";
  raw.forEach((line, index) => {
    const prefix = PREFIX.exec(line);
    const previous = key;
    if (prefix) key = `${prefix[1]}\t${prefix[2]}`;
    const lines = steps.get(key) ?? [];
    lines.push({ raw: line, text: (prefix ? line.slice(prefix[0].length) : line).replace(/\r$/, "").replace(STAMP, ""), index, anchor: !!prefix && key !== previous });
    steps.set(key, lines);
  });
  return steps;
}

const significant = (text: string): boolean => (!isResultLine(text) && OUTSIDE_TEST.test(text)) ||
  [FAIL, TIMED_OUT, FAIL_COUNT, ERROR, STEP_EXIT, GATE_VERDICT].some((r) => r.test(text));

/** Keep every boundary of malformed/overlapping groups: their state changes can make an otherwise innocent failure unaccounted. */
function cutStep(lines: Line[], kept: Set<number>): void {
  const groups: Group[] = [];
  let group: Group | undefined;
  let next = false;
  kept.add(lines[0]!.index); // A following unprefixed line must still belong to this step.
  for (const { text, index, anchor } of lines) {
    if (anchor) kept.add(index);
    const required = significant(text) || (next && !!text.trim());
    if (next && text.trim()) next = false;
    if (GROUP.test(text)) {
      if (group) group.clean = false;
      group = { head: index, clean: !group, important: required || kept.has(index), passes: [] };
      groups.push(group);
    } else if (text.startsWith("##[endgroup]")) {
      if (group) { group.end = index; group.important ||= required; }
      else kept.add(index);
      group = undefined;
    } else if (group) {
      group.important ||= required;
      if (text.startsWith("(pass) ")) group.passes.push(index);
    }
    if (required) kept.add(index);
    if (FAIL.test(text)) next = true;
  }
  for (const g of groups) {
    if (g.clean && g.end !== undefined && !g.important) continue;
    kept.add(g.head);
    if (g.end !== undefined) kept.add(g.end);
    if (g.important) for (const i of g.passes) kept.add(i);
  }
}

/** Output is a subsequence of the original lines; no prefix, title or timestamp is reconstructed. */
export function cutFailedJobLog(log: string): string {
  const raw = log.split("\n"), kept = new Set<number>();
  for (const [key, lines] of stepsOf(raw)) {
    // Gate echo validation reads every line, including arbitrary text that makes the verdict unaccountable.
    if (key === `${GATE.job}\t${GATE.step}` || lines.reduce((n, l) => n + Buffer.byteLength(l.raw) + 1, -1) <= STEP_SMALL) for (const l of lines) kept.add(l.index);
    else cutStep(lines, kept);
  }
  return raw.filter((_, i) => kept.has(i)).join("\n");
}
