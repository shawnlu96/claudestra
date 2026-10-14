import { expect, test } from "bun:test";
import { cutFailedJobLog } from "../src/lib/scheduler-merge-ci-log-cut.js";
import { parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";
import { ciLogFixture, wholeLog } from "./scheduler-merge-ci-log-fixture.js";

function subsequence(original: string, cut: string): boolean {
  const lines = original.split("\n");
  let next = 0;
  for (const l of cut.split("\n")) {
    while (next < lines.length && lines[next] !== l) next++;
    if (next++ >= lines.length) return false;
  }
  return true;
}
function equivalent(log: string): void {
  const cut = cutFailedJobLog(log);
  expect(parseFailedLog(cut)).toEqual(parseFailedLog(log));
  expect(subsequence(log, cut)).toBe(true);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(64 * 1024);
}
test("[验收线 1] real-size A / B / C shards keep failures and are original-line subsequences", () => {
  for (const kind of ["A", "B", "C"] as const) {
    const jobs = ciLogFixture(kind);
    for (const job of jobs) equivalent(job.log);
    equivalent(wholeLog(jobs));
  }
  const a = ciLogFixture("A")[0]!.log;
  expect(Buffer.byteLength(a)).toBe(934869);
  expect(a.match(/\(pass\) /g)?.length).toBe(3028);
  expect(a.match(/##\[group\]/g)?.length).toBe(219);
});
const large = (lines: string[]) => ["ignored", "z".repeat(70000), ...lines].join("\n");
test("[验收线 1] boundaries, next nonempty text, passes claiming errors, outside failures and totals", () => {
  const tails = [
    ["##[group]tests/a.test.ts:", "(pass) fine", "##[group]tests/b.test.ts:", "(fail) slow", "", "^ this test timed out after 5000ms.", "##[endgroup]", " 1 fail"],
    ["##[group]tests/a.test.ts:", "(fail) slow", "", "unrelated text", "^ this test timed out after 5000ms.", "##[endgroup]", " 1 fail"],
    ["##[group]tests/a.test.ts:", "error: output", "(pass) fine", "(fail) slow", "^ this test timed out after 5000ms.", "##[endgroup]", "(fail) slow", " 1 fail"],
    ["##[group]tests/a.test.ts:", "Unhandled error between tests", "(pass) fine", "##[endgroup]", " 1 fail"],
    ["##[group]tests/a.test.ts:", "(pass) title with an error between tests", "##[endgroup]",
      "##[group]tests/b.test.ts:", "(fail) slow", "^ this test timed out after 5000ms.", "##[endgroup]", " 1 fail"],
    ["##[group]tests/a.test.ts:", "(fail) slow", "##[endgroup]", " 1 fail", " 1 fail"],
    ["##[group]tests/a.test.ts:", "(pass) fine", "##[endgroup]", "(fail) outside", " 1 fail"],
    ["##[group]tests/a.test.ts:", "(pass) fine", "(fail) slow", "##[group]tests/b.test.ts:", "(pass) fine", "##[endgroup]", " 1 fail"],
  ];
  for (const tail of tails) equivalent(large(tail));
});
test("[验收线 1] small steps and CRLF lines remain intact", () => {
  const log = "job\tstep\t##[group]tests/a.test.ts:\r\njob\tstep\t(fail) x\r\njob\tstep\t 1 fail\r\n";
  expect(cutFailedJobLog(log)).toBe(log);
});

test("[验收线 1] huge gate step retains unrecognized echo text and cannot become a valid verdict", () => {
  const shard = ciLogFixture("C")[0]!.log;
  const gate = ["unexpected".repeat(9000), "##[error]分片没有全部成功：failure", "##[error]Process completed with exit code 1."]
    .map((l) => `typecheck + test + guard\tAll shards succeeded\t${l}`).join("\n");
  const original = `${shard}\n${gate}`, cut = cutFailedJobLog(original);
  expect(parseFailedLog(original)).toBeNull();
  expect(parseFailedLog(cut)).toBeNull();
  expect(subsequence(original, cut)).toBe(true);
});

test("[验收线 1] interleaved steps and unprefixed timeout evidence preserve the original step", () => {
  const p = (step: string, line: string) => `ci\t${step}\t${line}`;
  const log = [p("one", "ignored"), p("one", "z".repeat(70000)), p("one", "##[group]tests/a.test.ts:"),
    p("two", "ignored"), p("two", "z".repeat(70000)), p("two", "##[group]tests/b.test.ts:"), p("two", "(fail) b"),
    "^ this test timed out after 5000ms.", p("two", "##[endgroup]"), p("two", " 1 fail"), p("one", "ignored return to earlier step"), "(fail) a",
    "^ this test timed out after 5000ms.", p("one", "##[endgroup]"), p("one", " 1 fail")].join("\n");
  equivalent(log);
  expect(parseFailedLog(cutFailedJobLog(log))?.every((f) => f.timedOut)).toBe(true);
});

test("[验收线 1] exactly 64 KiB stays byte-for-byte intact", () => {
  const prefix = "ci\tstep\t";
  const log = prefix + "x".repeat(64 * 1024 - Buffer.byteLength(prefix));
  expect(cutFailedJobLog(log)).toBe(log);
});
