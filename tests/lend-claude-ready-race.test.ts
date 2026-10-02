/**
 * i28-CLP r1 P1-2：共享的 Claude 结论只按 at 往新里写（lend-claude-ready.ts publishClaudeReadiness：比较和写在同一个 BEGIN IMMEDIATE 写事务里）。
 * 两个真实 SQLite 连接 = 两个进程（常驻出借循环 / 推送收单）。交错注入同审查报告：在 A 读出库里旧值、还没写之前让 B 写一份更新的。
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedClaudeReadiness, CLAUDE_REASONS, noteClaudeReadiness, type ClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { publishClaudeReadiness, READY_KEY, sharedClaudeReadiness, syncClaudeReadiness } from "../src/lib/lend-claude-ready.js";
import { getMeta, openLendJournal, setMeta } from "../src/lib/lend-journal.js";

const dir = mkdtempSync(join(tmpdir(), "lend-claude-race-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => noteClaudeReadiness(null));
const T = Date.now();
const ready = (at: number): ClaudeReadiness => ({ ready: true, reason: null, at });
const down = (at: number): ClaudeReadiness => ({ ready: false, reason: CLAUDE_REASONS.loggedOut, at });
let n = 0;
/** 同一个 journal 文件的两个连接；B 不等锁（busy_timeout 0），插不进去就当场报错，测试不会卡 10 秒 */
function twoConnections(): { a: Database; b: Database; close(): void } {
  const path = join(dir, `race${++n}.sqlite`);
  const a = openLendJournal(path);
  const b = openLendJournal(path);
  b.exec("PRAGMA busy_timeout = 0");
  setMeta(a, "other", "preserved");
  return { a, b, close: () => { a.close(); b.close(); } };
}
/** 在 A 读 meta 的那条 SELECT 返回之后、A 写之前，让 B 写一份；记下 B 那次写的结果 */
function injectOnRead(a: Database, write: () => void): { outcome: string | null } {
  const seen = { outcome: null as string | null };
  const original = a.query.bind(a);
  a.query = ((sql: string) => {
    const q = original(sql);
    if (seen.outcome !== null || !sql.startsWith("SELECT value FROM lend_meta")) return q;
    return { get: (...args: unknown[]) => {
      const row = (q.get as (...x: unknown[]) => unknown)(...args);
      try { write(); seen.outcome = "written"; } catch (e) { seen.outcome = (e as Error).message; }
      return row;
    } };
  }) as typeof a.query;
  return seen;
}

test("报告里的交错：A 读到旧值之后 B 写更新的不可用 → B 插不进 A 的写事务；B 重试后更新的结论留下，没被 A 的旧结论覆盖", () => {
  const { a, b, close } = twoConnections();
  setMeta(a, READY_KEY, JSON.stringify(ready(T - 100)));
  noteClaudeReadiness(ready(T));
  const seen = injectOnRead(a, () => publishClaudeReadiness(b, down(T + 1)));
  syncClaudeReadiness(a);
  expect(seen.outcome).toMatch(/locked|busy/i); // 比较和写之间没有缝
  expect(publishClaudeReadiness(b, down(T + 1))).toBe(true); // B 那个进程照常重试
  expect(sharedClaudeReadiness(a)).toEqual(down(T + 1));
  syncClaudeReadiness(a); // A 下一次对齐：认更新的，也不会再写回旧的
  expect(cachedClaudeReadiness()).toEqual(down(T + 1));
  expect(sharedClaudeReadiness(b)).toEqual(down(T + 1));
  expect(getMeta(a, "other")).toBe("preserved");
  close();
});

test("B 的更新结论先落库、A 才拿着旧结论去写 → A 的条件写不生效，A 改认 B 的", () => {
  const { a, b, close } = twoConnections();
  setMeta(a, READY_KEY, JSON.stringify(ready(T - 100)));
  noteClaudeReadiness(ready(T));
  expect(publishClaudeReadiness(b, down(T + 1))).toBe(true);
  syncClaudeReadiness(a);
  expect(sharedClaudeReadiness(b)).toEqual(down(T + 1));
  expect(cachedClaudeReadiness()).toEqual(down(T + 1));
  close();
});

test("反向：更新的可用结论不会被旧的不可用覆盖；同一时刻的不重复写", () => {
  const { a, b, close } = twoConnections();
  expect(publishClaudeReadiness(a, ready(T))).toBe(true);
  expect(publishClaudeReadiness(b, down(T - 50))).toBe(false);
  expect(publishClaudeReadiness(b, down(T))).toBe(false);
  expect(sharedClaudeReadiness(b)).toEqual(ready(T));
  expect(getMeta(a, "other")).toBe("preserved");
  close();
});

test("库里是坏值 / 原因不在分类里：条件写照样覆盖", () => {
  const { a, close } = twoConnections();
  for (const bad of ["{", JSON.stringify({ ready: false, reason: "EACCES /Users/alice/.claude", at: T + 999 })]) {
    setMeta(a, READY_KEY, bad);
    expect(publishClaudeReadiness(a, ready(T))).toBe(true);
    expect(sharedClaudeReadiness(a)).toEqual(ready(T));
  }
  close();
});
