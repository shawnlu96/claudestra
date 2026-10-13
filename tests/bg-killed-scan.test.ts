/** BGW-1 notice-tail：首扫按时间往回分块读（小块尺寸逼出跨块拼行 / 超长行 / 末尾半行） */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRecentLines } from "../src/lib/bg-killed-scan.ts";

const dir = mkdtempSync(join(tmpdir(), "bgw1-scan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const rec = (t: number, pad = "") => JSON.stringify({ timestamp: new Date(t).toISOString(), pad });

test("跨块的行完整拼回、按文件顺序；读到早于 since 的块就停；末尾半行不算、end 停在最后一个换行后", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => rec(1000 * i, "é".repeat(i % 7)));
  const body = lines.join("\n") + "\n";
  const f = join(dir, "a.jsonl");
  writeFileSync(f, body + '{"timestamp":"half');
  const r = await readRecentLines(f, 30_000, 64);
  expect(r.end).toBe(Buffer.byteLength(body));
  expect(r.lines.slice(-10)).toEqual(lines.slice(30));
  expect(r.lines.length).toBeLessThan(40); // 没扫到文件头
  expect(lines.join("\n").endsWith(r.lines.join("\n"))).toBe(true);
});

test("单行比块还长也能拼回；since 早于全部记录就读到文件头", async () => {
  const lines = [rec(1), rec(2, "x".repeat(500)), rec(3)];
  const f = join(dir, "b.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  expect((await readRecentLines(f, 0, 64)).lines).toEqual(lines);
});

test("空文件 / 没有换行：没有行，end=0", async () => {
  const f = join(dir, "c.jsonl");
  writeFileSync(f, "");
  expect(await readRecentLines(f, 0, 64)).toEqual({ lines: [], end: 0 });
  writeFileSync(f, '{"half');
  expect(await readRecentLines(f, 0, 64)).toEqual({ lines: [], end: 0 });
});
