/**
 * 跨进程 advisory 锁(v2.20.1+,Codex review 2026-08-26 第 3 条):
 * manager 的写命令彼此串行,关掉 registry 等状态文件的
 * load→mutate→save 丢更新窗口(20 个 RMW 站点逐个包事务风险太大,
 * 改为命令级串行——并发的写命令本来就该排队)。
 *
 * 实现:mkdir 原子抢占 + mtime 过期回收(持有者崩溃不留死锁)。
 * **拿不到锁降级放行**(advisory):宁可退回旧的低概率竞态,也不把
 * 命令卡死/搞出自死锁——串行是增强,不是新的单点。
 */

import { mkdirSync, rmdirSync, statSync, utimesSync } from "fs";

const STALE_MS = 180_000; // restart 这类慢命令也就分钟级;超过按持有者已死回收
const RETRY_MS = 250;

export interface LockHandle {
  release: () => void;
}

/** 阻塞式获取(轮询,最多 waitMs);超时返回 null(调用方降级继续)。 */
export async function acquireLock(
  lockPath: string,
  waitMs = 20_000,
  staleMs = STALE_MS
): Promise<LockHandle | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockPath, { recursive: false });
      break; // 抢到
    } catch {
      // 已被持有:过期则回收(mtime 超龄 = 持有者大概率已死)
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { rmdirSync(lockPath); } catch { /* 别人先回收了 */ }
          continue;
        }
      } catch { /* 刚被释放,下轮就能抢 */ }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  // 长任务续租:每 30s touch 一次防被当过期回收
  const keepAlive = setInterval(() => {
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* 已释放 */ }
  }, 30_000);
  keepAlive.unref?.();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(keepAlive);
    try { rmdirSync(lockPath); } catch { /* 已被过期回收 */ }
  };
  return { release };
}
