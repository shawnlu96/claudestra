/**
 * 跨进程 advisory 锁(v2.20.1+,Codex review 2026-08-26 第 3 条):
 * manager 的写命令彼此串行,关掉 registry 等状态文件的
 * load→mutate→save 丢更新窗口(20 个 RMW 站点逐个包事务风险太大,
 * 改为命令级串行——并发的写命令本来就该排队)。
 *
 * 实现:mkdir 原子抢占 + mtime 过期回收(持有者崩溃不留死锁)。持有期间按过期时间的 1/3 续租,续租前核对 token:
 * 活着的持有者再慢也不会被当过期回收;被暂停(SIGSTOP / 睡眠)超过期限、锁已被回收的,恢复后不给别人续租。
 * 真正做受保护的事之前调 held():核对 token 并续一次,核不上 = 已失租,别做(Esc 发键前这样查,tests/file-lock.test.ts)。
 * 回收先 rename 走再核对 token 和 mtime:别人重建的锁、持有者刚续过租的锁都还回去。
 * **拿不到锁降级放行**(advisory):宁可退回旧的低概率竞态,也不把
 * 命令卡死/搞出自死锁——串行是增强,不是新的单点。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

const STALE_MS = 180_000; // restart 这类慢命令也就分钟级;超过按持有者已死回收
const RETRY_MS = 250;
const OWNER_FILE = "owner";

export interface LockHandle {
  release: () => void;
  /** 还是不是自己的锁(核对 token,是就顺手续租)。manager 的命令锁不查:它串行的是整条命令,中途失租也只能退回旧的低概率竞态 */
  held: () => boolean;
  /** 这次持有的 token：交给子进程，让它在写入前用 lockOwnedBy 自己核（调度服务的租约，lib/scheduler-lease-env.ts） */
  token: string;
}

const ownerOf = (dir: string): string | undefined => {
  try { return readFileSync(join(dir, OWNER_FILE), "utf8"); } catch { return undefined; /* 老版本建的空锁 / 刚建还没写 token */ }
};
/** 只读核对：path 上的锁此刻是不是 token 这次持有（不续租，子进程核父进程的租约用） */
export const lockOwnedBy = (path: string, token: string): boolean => ownerOf(path) === token;
const isStale = (dir: string, staleMs: number): boolean => {
  try { return Date.now() - statSync(dir).mtimeMs > staleMs; } catch { return false; /* 刚被释放 / 挪走:不算过期,下一轮再看 */ }
};
const newToken = () => `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

/** 回收过期锁:先 rename 到临时名(原子,两个回收者只有一个成功),再核对——stat 之后别人重建的新锁、持有者刚续过租的锁要还回去 */
function reclaim(lockPath: string, seen: string | undefined, staleMs: number): void {
  const tmp = `${lockPath}.stale-${newToken()}`;
  try { renameSync(lockPath, tmp); } catch { return; /* 别人先回收了,下一轮重抢 */ }
  if (ownerOf(tmp) !== seen || !isStale(tmp, staleMs)) {
    try { return renameSync(tmp, lockPath); } catch { /* 原位又有了新锁:拿走的这把只能作废,它的持有者释放时 token 对不上、不会误删 */ }
  }
  rmSync(tmp, { recursive: true, force: true });
}

/** 阻塞式获取(轮询,最多 waitMs);超时返回 null(调用方降级继续)。 */
export async function acquireLock(
  lockPath: string,
  waitMs = 20_000,
  staleMs = STALE_MS
): Promise<LockHandle | null> {
  const deadline = Date.now() + waitMs;
  const token = newToken();
  for (;;) {
    try {
      mkdirSync(lockPath, { recursive: false });
      writeFileSync(join(lockPath, OWNER_FILE), token);
      break; // 抢到
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // mkdir 成功、token 没写进去:这把锁没法按 token 释放,删掉当没抢到(不留一把只能等过期的锁)
        if (ownerOf(lockPath) === undefined) rmSync(lockPath, { recursive: true, force: true });
      }
      // 已被持有:过期则回收(mtime 超龄 = 持有者没在续租,大概率已死)
      try {
        const seen = ownerOf(lockPath);
        if (isStale(lockPath, staleMs)) {
          reclaim(lockPath, seen, staleMs);
          continue;
        }
      } catch { /* 回收时删临时目录失败:下轮再抢,最坏等它的持有者释放 */ }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  let released = false;
  let lost = false;
  /** 核对 token 再续租;核不上就认失租(之后一直算失租:锁被人回收过,自己的临界区已经不独占了) */
  const renew = (): boolean => {
    if (released || lost) return false;
    if (ownerOf(lockPath) !== token) return (lost = true), clearInterval(keepAlive), false;
    try { return utimesSync(lockPath, new Date(), new Date()), true; } catch { return (lost = true), clearInterval(keepAlive), false; /* 刚被回收挪走 */ }
  };
  const keepAlive = setInterval(renew, Math.min(30_000, Math.max(50, Math.floor(staleMs / 3))));
  keepAlive.unref?.();
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(keepAlive);
    if (ownerOf(lockPath) !== token) return void console.warn(`⚠️ 锁 ${lockPath} 已不是自己的(被当过期回收过),不去删别人的`);
    rmSync(lockPath, { recursive: true, force: true });
  };
  return { release, held: renew, token };
}
