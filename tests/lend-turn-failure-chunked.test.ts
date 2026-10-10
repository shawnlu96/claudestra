/**
 * 回合失败卡归属判定在大 rollout 上：回合开始之后又写了超过 1 MiB（工具输出等），也要从尾部分块倒读找到本回合的 task_started；
 * 每次 read 有上限、总读取量有上限，超出上限仍判「不确定」（不自动停单）。lend-turn-failure.ts lastTurnStartAt / turnFailureDoubt。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastTurnStartAt, turnFailureDoubt } from "../src/lib/lend-turn-failure.ts";

const SID = "01a1b2c3-0000-7000-8000-00000000c0de";
const T0 = Date.parse("2026-10-06T22:20:00Z");
const MiB = 1024 * 1024;
const CHUNK = 256 * 1024;
const line = (at: number, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type, ...extra } });
/** 回合中途的大块输出：一行约 8 KiB，带多字节字符（切块落在字中间也不能坏），还带「task_started」字样但不是回合开始 */
const filler = (bytes: number, at: number) => {
  const one = JSON.stringify({ timestamp: new Date(at).toISOString(), type: "response_item",
    payload: { type: "function_call_output", output: `"task_started" 输出 ${"汉字x".repeat(1000)}` } });
  return Array.from({ length: Math.ceil(bytes / (Buffer.byteLength(one) + 1)) }, () => one).join("\n");
};
const rollout = (...parts: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), "lend-turnfail-chunk-")), `rollout-${SID}.jsonl`);
  writeFileSync(p, `${parts.join("\n")}\n`);
  return p;
};
const card = (failedAt: number) => ({ extra: { failure: "error", sessionId: SID, failedAt } });
const row = { sessionId: SID, startedAt: T0 - 60_000 };

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => { spy?.mockRestore(); spy = null; });
/** 记下每次 readSync 读了多少字节，照常转给真实现 */
const readOriginal = fs.readSync;
const watchReads = () => {
  const lens: number[] = [];
  const real = readOriginal as (...a: unknown[]) => number; // readSync 有重载，Parameters 只取到最后一个
  spy = spyOn(fs, "readSync").mockImplementation(((...a: unknown[]) => {
    lens.push(a[3] as number);
    return real(...a);
  }) as typeof fs.readSync);
  return lens;
};

test("回归：回合开始之后写了 1.5 MiB（超出旧的尾部 1 MiB 窗口），仍判出失败属于本回合", () => {
  const p = rollout(line(T0 - 90_000, "session_meta"), line(T0, "task_started", { turn_id: "t2" }), filler(1.5 * MiB, T0 + 1_000));
  expect(fs.statSync(p).size - 1.5 * MiB).toBeGreaterThan(0);
  expect(lastTurnStartAt(p)).toBe(T0);
  expect(turnFailureDoubt(card(T0 + 300_000), row, () => p)).toBeNull();
});

test("对照：大 rollout 里没有 task_started → 仍判不确定；失败之后又开过新回合 → 仍不认", () => {
  const none = rollout(line(T0 - 90_000, "session_meta"), filler(1.5 * MiB, T0));
  expect(turnFailureDoubt(card(T0 + 300_000), row, () => none)).toContain("找不到回合开始记录");
  const again = rollout(line(T0, "task_started"), filler(1.2 * MiB, T0 + 1_000), line(T0 + 400_000, "task_started"), filler(1.2 * MiB, T0 + 401_000));
  expect(turnFailureDoubt(card(T0 + 300_000), row, () => again)).toBe("失败之后会话又开过新回合");
});

test("跨块：task_started 那一行正好被块边界切开，拼回来照样认；文件第一行就是 task_started 也认", () => {
  const tail = filler(CHUNK - 9_000, T0 + 1_000); // 行尾到文件尾 < CHUNK，行首到文件尾 > CHUNK
  const p = rollout(filler(600 * 1024, T0 - 50_000), line(T0, "task_started", { pad: "y".repeat(10_000) }), tail);
  const after = Buffer.byteLength(tail) + 2;
  expect(after).toBeLessThan(CHUNK);
  expect(after + Buffer.byteLength(line(T0, "task_started", { pad: "y".repeat(10_000) }))).toBeGreaterThan(CHUNK);
  expect(lastTurnStartAt(p)).toBe(T0);
  expect(lastTurnStartAt(rollout(line(T0, "task_started"), filler(700 * 1024, T0 + 1)))).toBe(T0);
});

test("读取有上限：每次 read ≤ 256 KiB、总量不超过上限；task_started 在上限之外 → null（不确定）", () => {
  const p = rollout(line(T0, "task_started"), filler(1.5 * MiB, T0 + 1_000));
  const size = fs.statSync(p).size;
  const lens = watchReads();
  expect(lastTurnStartAt(p, 512 * 1024)).toBeNull();
  expect(lens.length).toBeGreaterThan(1);
  expect(Math.max(...lens)).toBeLessThanOrEqual(CHUNK);
  expect(lens.reduce((a, b) => a + b, 0)).toBe(512 * 1024);
  lens.length = 0;
  expect(lastTurnStartAt(p)).toBe(T0); // 默认上限够：一路倒读到文件开头，每块仍 ≤ 256 KiB
  expect(Math.max(...lens)).toBeLessThanOrEqual(CHUNK);
  expect(lens.reduce((a, b) => a + b, 0)).toBe(size);
});
