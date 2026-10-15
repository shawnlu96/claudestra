/**
 * 迁移屏障:根外控制文件 control/barrier.json 存在即在维护中(内容坏了也算,宁可拒绝),不随 PID 消失,恢复完成前不自动解除。
 * 身份读取器生成前持同一把跨进程互斥(control/identity.lock)再查一次屏障:执行器也在这把互斥里落屏障,
 * 所以「查过屏障、还没生成」时进入维护的情形只能二选一——生成先完成(停写后的清单会看到它),或屏障先落(生成拒绝)。
 * 这不是对同用户恶意脚本的安全边界。tests/state-maintenance-barrier.test.ts。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { FILE_MODE, maintenanceRoot, maintPaths } from "./paths.js";

export class MaintenanceBarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceBarrierError";
  }
}

const barrierPath = (root: string): string => join(maintPaths(root).control, "barrier.json");
const mutexPath = (root: string): string => join(maintPaths(root).control, "identity.lock");

export interface BarrierInfo { runId: string; since: number; reason: string }

/** 屏障是否生效;读不了(权限等)也按生效处理 */
export function barrierActive(root: string = maintenanceRoot()): boolean {
  try {
    return existsSync(barrierPath(root)) || existsSync(`${barrierPath(root)}.tmp`);
  } catch (e) {
    console.error(`⚠️ 读不了维护屏障,按维护中处理:${(e as Error).message}`);
    return true;
  }
}

export function readBarrier(root: string): BarrierInfo | "corrupt" | null {
  try {
    const v = JSON.parse(readFileSync(barrierPath(root), "utf8")) as Partial<BarrierInfo>;
    return typeof v.runId === "string" && typeof v.since === "number" ? { runId: v.runId, since: v.since, reason: String(v.reason ?? "") } : "corrupt";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "corrupt";
  }
}

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * 同步互斥(身份读取器是同步 API)。O_EXCL 建锁文件写入 pid;持有者已死才回收。等不到就抛:
 * 宁可这次不生成,也不在不确定是否维护中时生成。控制目录不存在说明从未进过维护,返回 null(不建任何目录)。
 */
function acquireIdentityMutex(root: string, waitMs = 5_000): (() => void) | null {
  if (!existsSync(maintPaths(root).control)) return null;
  const path = mutexPath(root);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", FILE_MODE);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => releaseMutex(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new MaintenanceBarrierError(`取不到身份生成互斥:${(e as Error).message}`);
    }
    const holder = Number(readText(path));
    if (Number.isInteger(holder) && holder > 0 && !pidAlive(holder)) {
      try { unlinkSync(path); } catch { /* 别人先回收了:下一轮重抢就是 */ }
      continue;
    }
    if (Date.now() >= deadline) throw new MaintenanceBarrierError("身份生成互斥被占用,无法确认是否在维护中,拒绝生成");
    sleepSync(20);
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return ""; // 持有者刚释放 / 刚建还没写 pid:按「活着」处理,下一轮再看
  }
}

function releaseMutex(path: string): void {
  try {
    if (readText(path) === String(process.pid)) unlinkSync(path);
  } catch (e) {
    console.error(`⚠️ 释放身份生成互斥失败(持有者已死时下一位会回收):${(e as Error).message}`);
  }
}

/**
 * 身份读取器在「缺失 / 无效,要生成或替换」之前调用:持互斥、查屏障,维护中抛 MaintenanceBarrierError(调用方不得吞成无身份继续)。
 * 返回释放函数,生成完成后调用;生成本身要在持锁期间做完。
 */
export function enterIdentityGeneration(what: string, root: string = maintenanceRoot()): () => void {
  if (barrierActive(root)) throw new MaintenanceBarrierError(`状态根维护中,${what}缺失或无效,拒绝生成(不建目录、不写临时文件)`);
  const release = acquireIdentityMutex(root);
  if (barrierActive(root)) {
    release?.();
    throw new MaintenanceBarrierError(`状态根维护中,${what}缺失或无效,拒绝生成(不建目录、不写临时文件)`);
  }
  return release ?? (() => {});
}

/** 执行器落屏障:持同一互斥,写临时文件再改名(崩溃时残留的 .tmp 也按生效算) */
export function raiseBarrier(root: string, info: BarrierInfo): void {
  const release = acquireIdentityMutex(root, 30_000);
  if (!release) throw new Error("控制目录不存在,先建维护根");
  try {
    const tmp = `${barrierPath(root)}.tmp`;
    const fd = openSync(tmp, "w", FILE_MODE);
    writeSync(fd, JSON.stringify(info));
    closeSync(fd);
    renameSync(tmp, barrierPath(root));
  } finally {
    release();
  }
}

/** 解除屏障:只由执行器在校验或回滚成功后调用 */
export function liftBarrier(root: string, runId: string): void {
  const cur = readBarrier(root);
  if (cur === null) return;
  if (cur === "corrupt" || cur.runId !== runId) throw new Error("屏障不属于本次维护,不解除");
  unlinkSync(barrierPath(root));
}
