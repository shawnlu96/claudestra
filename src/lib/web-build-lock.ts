/**
 * web 构建锁（从 web-build.ts 原样搬出）：构建、发布、回滚、清理版本与待发布标记都在它下面串行（lib/web-releases.ts）。
 * 按持有者 pid 判死活、不按年龄接管——接管一个还活着的构建会删掉它的备份、让它失败时无从回滚。不可重入：
 * 已持有锁的流程（rebuildWebIfStale 里的发布）直接调不加锁的版本。
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { STATE_DIR } from "./paths.js";

const LOCK_PATH = `${STATE_DIR}/web-build.lock`;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 锁持有者是否还在构建。只看死活、不按年龄接管：备份目录是共用的，接管一个还活着的构建
 * 会删掉它的备份、让它失败时无从回滚。pid 被复用成别的进程时（不是 bun）按已死处理。
 */
function holderBusy(pid: number): boolean {
  if (!(pid > 0) || !pidAlive(pid)) return false;
  const comm = (spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).stdout || "").trim();
  return !comm || isBuilderComm(comm); // ps 读不到就当还活着：宁可这轮不建，也不删别人的备份
}

/** 构建都跑在 bun 进程里（manager / install-cli）；ps comm 可能是全路径 */
export function isBuilderComm(comm: string): boolean {
  return /(^|\/)bun$/.test(comm.trim());
}

export function takeLock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      let holder = 0;
      try { holder = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10); } catch { /* 读不到当孤儿 */ }
      if (holderBusy(holder)) return false;
      try { unlinkSync(LOCK_PATH); } catch { /* 被别人抢先清了，再试一次 */ }
    }
  }
  return false;
}

export function releaseLock(): void {
  try {
    if (parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10) === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* 已不在 */ }
}
