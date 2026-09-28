/**
 * web 构建锁：构建、发布、回滚、清理版本与待发布标记都在它下面串行（lib/web-releases.ts）。
 * 按持有者 pid 判死活、不按年龄接管——接管一个还活着的构建会删掉它的备份、让它失败时无从回滚。不可重入：
 * 已持有锁的流程（rebuildWebIfStale 里的发布）直接调不加锁的版本。
 *
 * 为什么要写成这样（codex 复核用两个进程复现过旧写法的双持有）：
 * - 创建：先把 pid 写进临时文件，再 link 到锁路径——link 是原子的且目标存在就失败，锁文件从诞生起就带完整 pid。
 *   旧写法 open("wx") 与写 pid 之间有空档，别人看到空文件当孤儿删掉，两边都以为自己拿到了锁。
 * - 内容读不出 pid（空、乱码、读失败）→ 不删、直接失败，留给人处理：身份不确定时宁可这轮不建。
 * - 持有者已死才接管：先把锁 rename 到自己独有的墓碑名，再核对墓碑里确实是那个死 pid；不是（期间别人已重建了锁）
 *   就原样放回并退出。剩余窗口：三方同时抢一个死锁时仍可能出错，概率极低，tests/web-build-lock.test.ts 压测过双方。
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { STATE_DIR } from "./paths.js";

const lockPath = () => `${STATE_DIR}/web-build.lock`;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 锁持有者是否还在构建。只看死活、不按年龄接管：备份目录是共用的，接管一个还活着的构建
 * 会删掉它的备份、让它失败时无从回滚。pid 被复用成别的进程时（不是 bun）按已死处理。
 */
function holderBusy(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  const comm = (spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout || "").trim();
  return !comm || isBuilderComm(comm); // ps 读不到就当还活着：宁可这轮不建，也不删别人的备份
}

/** 构建都跑在 bun 进程里（manager / install-cli）；ps comm 可能是全路径 */
export function isBuilderComm(comm: string): boolean {
  return /(^|\/)bun$/.test(comm.trim());
}

/** 锁文件里的 pid；读不到或不是正整数 → null（身份不确定） */
function readHolder(path: string): number | null {
  try {
    const t = readFileSync(path, "utf-8").trim();
    return /^\d+$/.test(t) && +t > 0 ? +t : null;
  } catch {
    return null; // 读失败按身份不确定处理（可能刚被别人删掉，这轮不抢）
  }
}

/** 带完整 pid 的锁文件一步到位：临时文件写好 pid → link 到锁路径（已存在就失败） */
function tryCreate(path: string): boolean {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch {
    return false; // 锁已存在
  } finally {
    unlinkSync(tmp);
  }
}

/** 持有者 deadPid 已死：把锁挪到自己的墓碑名，核对确实是它再删；不是就放回。返回是否清掉了死锁 */
function reapDead(path: string, deadPid: number): boolean {
  const tomb = `${path}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(path, tomb);
  } catch {
    return false; // 已被别人处理掉了
  }
  if (readHolder(tomb) === deadPid) {
    unlinkSync(tomb);
    return true;
  }
  try {
    linkSync(tomb, path); // 挪走的是别人刚建的活锁：原样放回
  } catch {
    // 放回时锁路径又被占了：这份活锁的持有者 release 时会发现不是自己的、不会误删别人
  }
  unlinkSync(tomb);
  return false;
}

export function takeLock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = lockPath();
  for (let i = 0; i < 2; i++) {
    if (tryCreate(path)) return true;
    const holder = readHolder(path);
    if (holder === null) {
      console.error(`[web-build-lock] 锁文件内容异常（${path}），不自动删除：确认没有构建在跑后手动删掉它`);
      return false;
    }
    if (holderBusy(holder) || !reapDead(path, holder)) return false;
  }
  return false;
}

export function releaseLock(): void {
  const path = lockPath();
  try {
    if (readHolder(path) === process.pid) unlinkSync(path);
  } catch { /* 已不在 */ }
}
