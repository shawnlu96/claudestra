/** merge-arch-CISHARD1：scripts/ci-test-durations.json（实测耗时表）——从分片作业日志重算、落盘格式、缺失 / 坏掉时的退路。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durationsFromLogs, formatDurations, loadDurations, parseDurations, planShards, testFiles } from "../scripts/ci-test-shard.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 12, 14, 55) + seconds * 1000).toISOString().replace("Z", "0000Z");
/** A shard job log as the Actions API returns it: every line stamped, each test file under its own group. */
const jobLog = (rows: [string, number][], end: number | null) => [
  `﻿${at(0)} ##[group]Run bun run --silent test:shard 2/8 > "$RUNNER_TEMP/files.txt"`,
  `${at(1)} ##[endgroup]`,
  `${at(2)} bun test v1.3.14 (0d9b296a)`,
  ...rows.flatMap(([file, start]) => [`${at(start)} ##[group]${file}:`, `${at(start + 0.01)} (pass) ok [1.00ms]`, `${at(start + 0.02)} ##[endgroup]`]),
  ...(end === null ? [] : [`${at(end)} Ran 3 tests across ${rows.length} files. [9.00s]`, `${at(end + 5)} ##[group]Run actions/upload-artifact@v4`]),
].join("\n");

describe("durationsFromLogs", () => {
  test("a file's seconds run from its group line to the next file's, the last one to the summary line", () => {
    const log = jobLog([["tests/a.test.ts", 10], ["tests/b.test.ts", 12.5], ["tests/c.test.ts", 72.5]], 73);
    expect(durationsFromLogs([log])).toEqual({ "tests/a.test.ts": 2.5, "tests/b.test.ts": 60, "tests/c.test.ts": 0.5 });
  });
  test("several runs: the median per file; `gh run view --log` prefixes and ::group:: lines read the same", () => {
    const run = (b: number) => jobLog([["tests/a.test.ts", 10], ["tests/b.test.ts", 11]], 11 + b);
    const viaGh = run(9).split("\n").map((l) => `test shard 2 of 8\tUnit tests\t${l.replace("##[group]", "::group::")}`).join("\n");
    expect(durationsFromLogs([run(3), run(40), viaGh])).toEqual({ "tests/a.test.ts": 1, "tests/b.test.ts": 9 });
    expect(durationsFromLogs([run(3), run(5)])["tests/b.test.ts"]).toBe(4);
  });
  test("a log that never reached the summary leaves its last file unmeasured; lines without a timestamp count for nothing", () => {
    expect(durationsFromLogs([jobLog([["tests/a.test.ts", 10], ["tests/b.test.ts", 14]], null)])).toEqual({ "tests/a.test.ts": 4 });
    expect(durationsFromLogs(["::group::tests/a.test.ts:\n::group::tests/b.test.ts:\nRan 2 tests across 2 files. [1.00s]"])).toEqual({});
  });
});

describe("the duration table on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cstra-durations-"));
  test("formatDurations is JSON that parses back, sorted by path, three entries a line", () => {
    const seconds = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`tests/f${6 - i}.test.ts`, i + 0.25]));
    const text = formatDurations(seconds);
    expect(parseDurations(text)).toEqual(seconds);
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(seconds).sort());
    expect(text.split("\n")).toHaveLength(6);
  });
  test("a missing or unparsable table: every file weighs the same, with a note and no throw", () => {
    const files = Array.from({ length: 40 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
    const bad = join(dir, "bad.json");
    for (const [path, content, why] of [[join(dir, "none.json"), null, "不存在"], [bad, "{ not json", "解析失败"], [bad, "[1, 2]", "解析失败"],
      [bad, '{"tests/a.test.ts": "3"}', "解析失败"], [bad, '{"tests/a.test.ts": -1}', "解析失败"]] as const) {
      if (content !== null) writeFileSync(path, content);
      const d = loadDurations(path);
      expect(d.seconds).toEqual({});
      expect(d.note).toContain(why);
      const plan = planShards(files, 8, d.seconds, 0);
      expect(plan.flat().sort()).toEqual(files);
      expect(plan.map((p) => p.length)).toEqual(Array(8).fill(5));
    }
    rmSync(dir, { recursive: true, force: true });
  });
  test("the checked-in table parses, is in the format the durations command writes, and measures the files it names", () => {
    const path = join(import.meta.dir, "..", "scripts", "ci-test-durations.json");
    const d = loadDurations(path);
    expect(d.note).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(formatDurations(d.seconds));
    expect(readFileSync(path, "utf8").split("\n").length).toBeLessThanOrEqual(800);
    expect(testFiles(Object.keys(d.seconds).join("\n"))).toHaveLength(Object.keys(d.seconds).length);
  });
});
