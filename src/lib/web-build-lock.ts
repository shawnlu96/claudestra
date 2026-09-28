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
 *   就原样放回并退出。已知剩余窗口（审查员复现过）：有崩溃残锁、且三方在同一毫秒内抢接管时，放回前约 100µs 里
 *   第三方可能建锁成功，造成双持有。根治要用 flock（内核随进程释放），这里只把它压到这个量级。
 * - 失败原因要报出去（lockStatus）：只有「锁已存在且持有者活着」才算忙；锁内容异常、非 EEXIST 的文件系统错误
 *   都是错误——当成「忙」会让自动更新从此静默地不再部署网页。
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { STATE_DIR } from "./paths.js";

const lockPath = () => `${STATE_DIR}/web-build.lock`;
let last: { problem?: string; holder?: number } = {};

/** 上一次 takeLock 失败的原因：problem = 锁本身出了问题（带路径，调用方按错误报）；holder = 正在构建的进程 pid */
export function lockStatus(): { problem?: string; holder?: number } {
  return last;
}

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

/** 锁文件里的 pid；文件已不在 → "gone"（持有者刚释放，可以再抢）；读到了但不是正整数 → null（身份不确定） */
function readHolder(path: string): number | null | "gone" {
  let t: string;
  try {
    t = readFileSync(path, "utf-8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e; // 权限等真正的错误交给 takeLock 报出去
  }
  return /^\d+$/.test(t) && +t > 0 ? +t : null;
}

/** 带完整 pid 的锁文件一步到位：临时文件写好 pid → link 到锁路径（已存在就失败） */
function tryCreate(path: string): boolean {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; // 锁已存在
    throw e; // 磁盘满、没权限、文件系统不支持硬链接：是错误，不是「忙」
  } finally {
    rmSync(tmp, { force: true });
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
    // 放回时锁路径又被第三方占了：就是文件头注释说的剩余窗口，这里只能不再扩大它
  }
  rmSync(tomb, { force: true });
  return false;
}

/** 拿锁；永不抛。失败时看 lockStatus()：有 problem 是错误，只有 holder 是别人在构建 */
export function takeLock(): boolean {
  last = {};
  const path = lockPath();
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    for (let i = 0; i < 3; i++) {
      if (tryCreate(path)) return true;
      const holder = readHolder(path);
      if (holder === "gone") continue; // 持有者刚释放：再抢
      if (holder === null) {
        last = { problem: `web 构建锁文件内容异常（${path}）：确认没有 web 构建在跑之后手动删掉它` };
        return false;
      }
      if (holderBusy(holder)) {
        last = { holder };
        return false;
      }
      reapDead(path, holder);
    }
    return false;
  } catch (e) {
    last = { problem: `web 构建锁出错（${path}）：${(e as Error).message}` };
    return false;
  }
}

export function releaseLock(): void {
  const path = lockPath();
  try {
    if (readHolder(path) === process.pid) unlinkSync(path);
  } catch { /* 已不在或读不了：确认不了是自己的锁就不删 */ }
}
