/**
 * lib/file-lock.ts：活着的持有者按过期时间的 1/3 续租，再慢也不会被当过期回收；释放只删自己的锁；
 * 持有者崩了（不再续租）过期后照样回收。回归：T13a wf2 esc-keys-1（Esc 锁 5 秒过期、卡住的 tmux 调用超过它，锁被回收后两发 Esc 挨在一起）。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireLock } from "../src/lib/file-lock.js";

let dir = "";
let lock = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-lock-"));
  lock = join(dir, "x.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("持有时间超过过期时间：持有者在续租，等锁的拿不到（不会被当过期回收）", async () => {
  const a = await acquireLock(lock, 100, 300);
  expect(a).not.toBeNull();
  const b = await acquireLock(lock, 900, 300); // 等 0.9 秒 = 过期时间的 3 倍
  expect(b).toBeNull();
  a!.release();
  expect(existsSync(lock)).toBe(false);
});

test("持有者崩了（锁目录不再续租）：过期后回收，新持有者拿到", async () => {
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "dead.1");
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  const b = await acquireLock(lock, 1_000, 300);
  expect(b).not.toBeNull();
  expect(readFileSync(join(lock, "owner"), "utf8")).not.toBe("dead.1");
  b!.release();
});

test("老版本留下的空锁目录（没有 token）过期也能回收", async () => {
  mkdirSync(lock);
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  const b = await acquireLock(lock, 1_000, 300);
  expect(b).not.toBeNull();
  b!.release();
  expect(existsSync(lock)).toBe(false);
});

test("锁已经换了主人（自己被当过期回收过）：释放不删别人的锁", async () => {
  const a = await acquireLock(lock, 100, 300);
  writeFileSync(join(lock, "owner"), "someone-else"); // 模拟：被回收后别人重建了这把锁
  a!.release();
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(join(lock, "owner"), "utf8")).toBe("someone-else");
});

test("正常串行：释放之后下一个马上拿到", async () => {
  const a = await acquireLock(lock, 100, 5_000);
  const pending = acquireLock(lock, 2_000, 5_000);
  setTimeout(() => a!.release(), 100);
  const b = await pending;
  expect(b).not.toBeNull();
  b!.release();
});
