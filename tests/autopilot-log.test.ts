/** lib/autopilot-log.ts：每条 mission 一个 jsonl、坏行跳过、id 不拼进路径、给人看的一行 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunLog, formatRunLine, readRunLog, type RunLogLine } from "../src/lib/autopilot-log.js";
import { emptyEvidence } from "../src/lib/autopilot-run.js";

const line = (over: Partial<RunLogLine> = {}): RunLogLine => ({
  ts: "2026-09-28T11:05:00Z", missionId: "abc123", agent: "w", outcome: "action_taken", reason: "调了 3 个工具，其中 1 个可能改了东西", ...over,
});

describe("appendRunLog / readRunLog", () => {
  test("追加、按 mission 分文件、取最近 N 行；没有文件 = 空", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-log-"));
    expect(readRunLog("abc123", 10, dir)).toEqual([]);
    for (let i = 0; i < 5; i++) appendRunLog(line({ runId: `r${i}` }), dir);
    appendRunLog(line({ missionId: "other" }), dir);
    expect(readRunLog("abc123", 3, dir).map((l) => l.runId)).toEqual(["r2", "r3", "r4"]);
    expect(readRunLog("other", 10, dir)).toHaveLength(1);
  });
  test("半行 / 坏行跳过；missionId 形状不对落到 unknown，不拼进路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-log-"));
    appendRunLog(line(), dir);
    appendFileSync(join(dir, "abc123.jsonl"), '{"ts":"x","outc\n');
    appendRunLog(line({ runId: "r9" }), dir);
    expect(readRunLog("abc123", 10, dir)).toHaveLength(2);
    appendRunLog(line({ missionId: "../../evil" }), dir);
    expect(existsSync(join(dir, "unknown.jsonl"))).toBe(true);
  });
});

describe("formatRunLine", () => {
  test("回答三件事：推进了没有、发现了什么、为什么没执行", () => {
    const s = formatRunLine(line({
      startedAt: "2026-09-28T11:00:00Z", durationMs: 5 * 60_000, nextWakeAt: "2026-09-28T11:06:00Z", why: "干了活，接着推",
      evidence: { ...emptyEvidence(), humanInterleaved: true },
    }));
    expect(s).toContain("action_taken 5 分钟");
    expect(s).toContain("中途有人插话");
    expect(s).toContain("（干了活，接着推）");
    expect(formatRunLine(line({ outcome: "skipped", reason: "排队 30 分钟没推进：主回合在跑" }))).toContain("skipped · 排队 30 分钟没推进");
  });
});
