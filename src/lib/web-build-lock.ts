/**
 * web 构建锁：构建、发布、回滚、清理版本与待发布标记都在它下面串行（lib/web-releases.ts）。
 * 按持有者 pid 判死活、不按年龄接管——接管一个还活着的构建会删掉它的备份、让它失败时无从回滚。不可重入：
 * 已持有锁的流程（rebuildWebIfStale 里的发布）直接调不加锁的版本。
 *
 * 为什么要写成这样（codex 复核用两个进程复现过旧写法的双持有）：
 * - 创建：先把 pid 写进临时文件，再 link 到锁路径——link 是原子的且目标存在就失败，锁文件从诞生起就带完整 pid。
 *   旧写法 open("wx") 与写 pid 之间有空档，别人看到空文件当孤儿删掉，两边都以为自己拿到了锁。
 * - 内容读不出 pid（空、乱码、读失败）→ 不删、直接失败，留给人处理：身份不确定时宁可这轮不建。
 * - 持有者已死才接管，且接管者之间互斥：先用同样的 link 手法拿「接管锁」，拿到后重读持有者、确认已死才 unlink。
 *   接管锁在手时锁路径只可能被持有者本人删，死者删不了，所以读和删之间锁不会变。旧写法拿过期读数去 rename
 *   别人刚建的活锁再放回，放回前锁路径是空的，第三方趁机建锁，4 进程抢接管时约三成轮次双持有（见 tests/web-build-lock.test.ts）。
 *   接管锁残留（接管者在很短的临界区里崩溃）→ 按 problem 报错、留给人删，不猜。
 * - 失败原因要报出去（lockStatus）：只有「锁已存在且持有者活着」才算忙；锁内容异常、非 EEXIST 的文件系统错误
 *   都是错误——当成「忙」会让自动更新从此静默地不再部署网页。
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * 锁持有者看着已死：拿接管锁后重读确认再删。别人正在接管 → 等一下让主循环再抢；
 * 接管锁的主人已死或内容异常 → 抛错，由 takeLock 报成 problem。
 */
function reapDead(path: string): void {
  const guard = `${path}.reap`;
  if (!tryCreate(guard)) {
    const g = readHolder(guard);
    if (g === "gone" || (g !== null && holderBusy(g))) {
      Bun.sleepSync(1); // 接管临界区很短（最多一次 ps），等它做完；主循环 20 轮足够等到
      return;
    }
    throw new Error(`接管锁残留（${guard}）：确认没有 web 构建在跑之后手动删掉它`);
  }
  try {
    const holder = readHolder(path);
    if (typeof holder === "number" && !holderBusy(holder)) unlinkSync(path);
  } finally {
    unlinkSync(guard);
  }
}

/** 拿锁；永不抛。失败时看 lockStatus()：有 problem 是错误，只有 holder 是别人在构建 */
export function takeLock(): boolean {
  last = {};
  const path = lockPath();
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    for (let i = 0; i < 20; i++) {
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
      reapDead(path);
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
