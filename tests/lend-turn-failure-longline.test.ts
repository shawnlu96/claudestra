/**
 * 倒读遇到没有换行的超长单行：残行按块存、遇到换行（或读到文件开头）才拼一次，累计复制量随文件大小线性，不再每块重拼整段残行。
 * lend-turn-failure.ts lastTurnStartAt。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastTurnStartAt } from "../src/lib/lend-turn-failure.ts";

const MiB = 1024 * 1024;
const T0 = Date.parse("2026-10-06T22:20:00Z");
const rec = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "response_item", payload: { type, ...extra } });
const longLine = (bytes: number) => rec("function_call_output", { output: "x".repeat(bytes) });
const dirs: string[] = [];
const rollout = (...lines: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "lend-turnfail-long-"));
  dirs.push(dir);
  const p = join(dir, "rollout.jsonl");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
};

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); // 每份夹具十几 MiB，不留在 TMPDIR
});
/** 累计 Buffer.concat / Buffer.from(Buffer) 拷贝的字节数，照常转给真实现 */
const watchCopies = () => {
  const total = { bytes: 0 };
  const concat = Buffer.concat.bind(Buffer);
  const from = Buffer.from.bind(Buffer) as (...a: unknown[]) => Buffer;
  spies.push(spyOn(Buffer, "concat").mockImplementation(((list: readonly Uint8Array[], len?: number) => {
    const out = concat(list, len);
    total.bytes += out.length;
    return out;
  }) as typeof Buffer.concat));
  spies.push(spyOn(Buffer, "from").mockImplementation(((...a: unknown[]) => {
    const out = from(...a);
    if (a[0] instanceof Uint8Array) total.bytes += out.length;
    return out;
  }) as typeof Buffer.from));
  return total;
};

test("16 MiB 单行、没有 task_started：累计复制 ≤ 文件大小（线性），仍判 null", () => {
  for (const p of [rollout(longLine(16 * MiB)), rollout(rec("session_meta"), longLine(16 * MiB), rec("agent_message"))]) {
    const size = statSync(p).size;
    const copies = watchCopies();
    expect(lastTurnStartAt(p)).toBeNull();
    expect(copies.bytes).toBeLessThanOrEqual(size);
    for (const s of spies.splice(0)) s.mockRestore();
  }
});

test("超长单行前面的 task_started 照样找到（超长行本身拼一次也照常判）", () => {
  const start = JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "event_msg", payload: { type: "task_started" } });
  const p = rollout(start, longLine(4 * MiB));
  const copies = watchCopies();
  expect(lastTurnStartAt(p)).toBe(T0);
  expect(copies.bytes).toBeLessThanOrEqual(statSync(p).size);
});
